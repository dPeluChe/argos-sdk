import { logger, type Log } from '../debug.js';
import { resolveEndpoint, tracesUrl, type Endpoint } from '../dsn.js';
import { newTraceId } from '../ids.js';
import { sendHeartbeat } from '../heartbeat.js';
import { deliverForAnswer } from '../transport.js';
import type { InitOptions } from '../types.js';
import type { Spine } from '../server/spine.js';
import {
  KIND_CLIENT,
  KIND_INTERNAL,
  STATUS_ERROR,
  STATUS_OK,
  capped,
  customAttrs,
  dbl,
  draft,
  encodeRequest,
  int,
  str,
  type Attrs,
  type Draft,
} from './otlp.js';

declare const __ARGOS_VERSION__: string;

export { spineFrom, type Spine } from '../server/spine.js';

const SCOPE = '@argos/browser/agents';
const HEARTBEAT_SDK = '@argos/browser/agents';
const MAX_QUEUE = 1_000;
const MAX_BATCH = 100;
const FLUSH_DELAY_MS = 5_000;
const CONTENT_CAP = 8_192;
const TEXT_CAP = 256;
const REQUEST_TIMEOUT_MS = 10_000;
/** `gen_ai.operation.name` of a step: the server needs one gen_ai.* attribute to keep a span. */
const STEP_OPERATION = 'step';

export type Outcome = 'completed' | 'failed' | 'cancelled';

/**
 * Your own span attributes (a run id, a trigger). At most 32 per span, keys up
 * to 128 characters, strings cut at 512. Keys starting with `gen_ai.` or
 * `argos.`, and `error.type`, belong to the SDK and are dropped (see `debug`).
 */
export type Attributes = Record<string, string | number | boolean>;

export interface AgentsOptions extends Pick<
  InitOptions,
  'dsn' | 'projectId' | 'publicKey' | 'host' | 'environment' | 'release' | 'debug' | 'heartbeat'
> {
  /** `service.name` of the process; defaults to `argos-agents`. */
  serviceName?: string;
  /**
   * Content the caller hands to `end()` (messages, tool arguments and results)
   * is sent by default; the SDK never invents any. `false` strips it before
   * anything leaves the process. The Argos server can also drop it
   * (`ARGOS_AGENT_DROP_CONTENT=true`).
   */
  captureContent?: boolean;
}

export interface TurnOptions {
  agent: string;
  /** The model the agent runs on, when one model drives the whole turn. */
  model?: string;
  provider?: string;
  /** From `spineFrom(headers)` or a `Visit`: the turn joins that visitor's session. */
  spine?: Spine | { readonly spine: Spine };
  sessionId?: string;
  anonId?: string;
  userId?: string;
  accountId?: string;
  /** An abort of this signal, or an `AbortError`, ends the turn as `cancelled`, not `failed`. */
  signal?: AbortSignal;
  /** On the turn's own span only. */
  attributes?: Attributes;
}

export interface ModelOptions {
  /** Defaults to the `provider` given to `turn()`. */
  provider?: string;
  /** Defaults to the `model` given to `turn()`. */
  model?: string;
  /** Defaults to `chat`. */
  operation?: string;
  attributes?: Attributes;
}

/** Cached and reasoning counts are subsets of input and output, never additions. */
export interface ModelEnd {
  inputTokens?: number;
  outputTokens?: number;
  /** Cache reads: already inside `inputTokens`. */
  cachedInputTokens?: number;
  /** Cache creation: already inside `inputTokens`. */
  cacheWriteTokens?: number;
  /** Already inside `outputTokens`. */
  reasoningOutputTokens?: number;
  /** Cost the provider or gateway reported, in USD. Omit it and the server prices the call. */
  costUsd?: number;
  responseModel?: string;
  /** Stripped when `captureContent` is `false`. */
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface ToolOptions {
  name: string;
  attributes?: Attributes;
}

export interface StepOptions {
  /** What the step is (`human_approval`, `retrieval`, `subagent`); also in the span name. */
  name: string;
  attributes?: Attributes;
}

export interface StepEnd {
  /** Stripped when `captureContent` is `false`. */
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface FlushOptions {
  /** Stop waiting after this long: resolves `false` and keeps the undelivered spans for the next flush. */
  timeoutMs?: number;
}

export interface ToolRun<T> {
  /** Stripped when `captureContent` is `false`. */
  arguments?: unknown;
  /** Reads the content to record off the result; without it no result is sent. */
  resultOf?: (result: T) => unknown;
}

export interface ToolEnd {
  /** Stripped when `captureContent` is `false`. */
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface TurnEnd {
  /** Defaults to `failed` when `error` is given, `completed` otherwise. */
  outcome?: Outcome;
  error?: unknown;
  /** Why a `cancelled` turn was cut, cut at 256 characters. Ignored for any other outcome. */
  reason?: string;
  /** The run's own input and output; stripped when `captureContent` is `false`. */
  input?: unknown;
  output?: unknown;
}

const USAGE = [
  ['inputTokens', 'gen_ai.usage.input_tokens'],
  ['outputTokens', 'gen_ai.usage.output_tokens'],
  ['cachedInputTokens', 'gen_ai.usage.cache_read.input_tokens'],
  ['cacheWriteTokens', 'gen_ai.usage.cache_creation.input_tokens'],
  ['reasoningOutputTokens', 'gen_ai.usage.reasoning.output_tokens'],
] as const;

function identity(provider: string | undefined, model: string | undefined): Attrs {
  const attrs: Attrs = {};
  if (provider) attrs['gen_ai.provider.name'] = str(provider);
  if (model) attrs['gen_ai.request.model'] = str(model);
  return attrs;
}

const nameOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;

/**
 * A supervisor cut is not a failure: an AbortError, or the signal's own
 * reason. A deadline (`AbortSignal.timeout`) is a failure, so it is excluded.
 */
function isCancel(error: unknown, signal: AbortSignal | undefined): boolean {
  if (nameOf(error) === 'AbortError') return true;
  return signal?.aborted === true && error === signal.reason && nameOf(error) !== 'TimeoutError';
}

function fail(span: Draft, error: unknown): void {
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'failed';
  span.status = { code: STATUS_ERROR, message: text.slice(0, TEXT_CAP) };
  span.attrs['error.type'] = str(error instanceof Error ? error.name : 'Error');
}

async function observe<T>(
  signal: AbortSignal | undefined,
  fn: () => T | PromiseLike<T>,
  onOk: (result: T) => void,
  onFail: (error: unknown, cancelled: boolean) => void,
): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    onFail(error, isCancel(error, signal));
    throw error;
  }
  onOk(result);
  return result;
}

/**
 * Agent runs as OTLP traces: one trace per turn, a span per model call and per
 * tool call. Nothing here ever throws into the agent it observes, and nothing
 * leaves the host until a turn ends.
 */
export class Agents {
  private endpoint: Endpoint | undefined;
  private readonly resource: Attrs;
  private readonly log: Log | undefined;
  private queue: Draft[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<boolean> = Promise.resolve(true);
  /** @internal */
  readonly captureContent: boolean;
  /** Cumulative: spans lost to a full queue. */
  dropped = 0;

  constructor(options: AgentsOptions) {
    this.log = logger(options.debug);
    this.captureContent = options.captureContent !== false;
    try {
      this.endpoint = resolveEndpoint(options);
      this.log?.(`agents ${this.endpoint.baseUrl} project ${this.endpoint.projectId}`);
    } catch (cause) {
      // A DSN typo must not stop the agent booting: spans are dropped instead.
      console.error('argos: agents disabled, init failed —', cause);
    }
    this.resource = {
      'service.name': str(options.serviceName ?? 'argos-agents'),
      'deployment.environment.name': str(options.environment ?? 'production'),
      'telemetry.sdk.name': str('@argos/browser'),
      'telemetry.sdk.language': str('nodejs'),
      'telemetry.sdk.version': str(__ARGOS_VERSION__),
    };
    if (options.release) this.resource['service.version'] = str(options.release);
    if (this.endpoint && options.heartbeat !== false) {
      sendHeartbeat(
        'process',
        this.endpoint,
        {
          environment: options.environment ?? 'production',
          release: options.release ?? null,
          runtime: 'node',
        },
        HEARTBEAT_SDK,
        this.log,
      );
    }
  }

  turn(options: TurnOptions): Turn {
    return this.attempt(() => new Turn(this, options)) ?? new Turn(this, { agent: 'unknown' });
  }

  /**
   * Sends what has been collected, and resolves whether it was all delivered.
   * With `timeoutMs` it waits at most that long and then resolves `false`; the
   * spans it could not deliver stay queued for the next flush.
   */
  flush({ timeoutMs }: FlushOptions = {}): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const cut = new AbortController();
    // Chained, so an awaited flush also waits for one already on the wire.
    this.chain = this.chain.then(() =>
      this.drain(timeoutMs === undefined ? undefined : cut.signal),
    );
    if (timeoutMs === undefined) return this.chain;
    // The race is needed: behind a slower flush the abort alone would not return on time.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        cut.abort();
        resolve(false);
      }, timeoutMs);
    });
    return Promise.race([this.chain, late]).finally(() => {
      clearTimeout(timer);
    });
  }

  /** @internal */
  attempt<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (cause) {
      this.log?.(`telemetry error: ${cause instanceof Error ? cause.message : 'unknown'}`);
      return undefined;
    }
  }

  /** @internal */
  custom(input: Attributes | undefined): Attrs {
    if (!input) return {};
    const dropped = (key: string, why: string): void =>
      this.log?.(`attribute "${key}" dropped: ${why}`);
    return this.attempt(() => customAttrs(input, dropped)) ?? {};
  }

  /** @internal */
  accept(spans: Draft[]): void {
    this.attempt(() => {
      if (!this.endpoint) return;
      this.queue = this.queue.concat(spans);
      this.trim();
      if (this.queue.length >= MAX_BATCH) void this.flush();
      else this.arm();
    });
  }

  private trim(): void {
    const over = this.queue.length - MAX_QUEUE;
    if (over <= 0) return;
    this.queue.splice(0, over);
    this.dropped += over;
    this.log?.(`queue full: dropped the ${String(over)} oldest span(s)`);
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
    // Do not keep a finished process alive for spans: exit paths call flush().
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async drain(cut?: AbortSignal): Promise<boolean> {
    const { endpoint } = this;
    if (!endpoint || this.queue.length === 0) return true;
    if (cut?.aborted) {
      this.arm();
      return false;
    }
    const batch = this.queue;
    this.queue = [];
    let delivered = true;
    try {
      for (let i = 0; i < batch.length; i += MAX_BATCH) {
        const chunk = batch.slice(i, i + MAX_BATCH);
        const body = encodeRequest(this.resource, SCOPE, chunk);
        const answer = await deliverForAnswer(
          tracesUrl(endpoint),
          endpoint.publicKey,
          body,
          this.log,
          { requestTimeoutMs: REQUEST_TIMEOUT_MS, ...(cut && { signal: cut }) },
        );
        if (answer === false && cut?.aborted) {
          // Cut short, not refused: this chunk and the rest wait for the next flush.
          this.queue = batch.splice(i).concat(this.queue);
          this.trim();
          this.arm();
          return false;
        }
        this.log?.(
          `flush ${String(chunk.length)} span(s): ${answer === false ? 'failed' : 'delivered'}`,
        );
        if (answer === false) delivered = false;
        else this.reportRejected(answer);
      }
    } catch (cause) {
      this.log?.(`flush failed: ${cause instanceof Error ? cause.message : 'unknown'}`);
      delivered = false;
    }
    return delivered;
  }

  /** OTLP partial success: the request was accepted but some spans were not. */
  private reportRejected(answer: unknown): void {
    const partial = (answer as { partialSuccess?: Record<string, unknown> } | null)?.partialSuccess;
    const rejected = Number(partial?.['rejectedSpans'] ?? 0);
    if (rejected > 0) {
      const reason = partial?.['errorMessage'];
      this.log?.(
        `server rejected ${String(rejected)} span(s)${typeof reason === 'string' ? `: ${reason}` : ''}`,
      );
    }
  }
}

/** Where model calls, tool calls and steps open: the turn itself, or a step inside it. */
export abstract class Scope {
  /** @internal */
  protected abstract readonly host: Turn;
  protected abstract get parentId(): string;

  model(options: ModelOptions = {}): ModelCall {
    const operation = options.operation ?? 'chat';
    const provider = options.provider ?? this.host.defaults.provider;
    const model = options.model ?? this.host.defaults.model;
    const attrs: Attrs = { 'gen_ai.operation.name': str(operation), ...identity(provider, model) };
    const name = model ? `${operation} ${model}` : operation;
    const span = this.host.child(this.parentId, name, KIND_CLIENT, attrs, options.attributes);
    return new ModelCall(this.host, span);
  }

  tool(options: ToolOptions): ToolCall {
    const attrs: Attrs = {
      'gen_ai.operation.name': str('execute_tool'),
      'gen_ai.tool.name': str(options.name),
    };
    const name = `execute_tool ${options.name}`;
    const span = this.host.child(this.parentId, name, KIND_INTERNAL, attrs, options.attributes);
    return new ToolCall(this.host, span);
  }

  /** A step that is neither a model nor a tool call (an approval, a retrieval, a subagent); steps nest. */
  step(options: StepOptions): Step {
    const attrs: Attrs = {
      'gen_ai.operation.name': str(STEP_OPERATION),
      'argos.step.name': str(options.name.slice(0, TEXT_CAP)),
    };
    const name = `${STEP_OPERATION} ${options.name}`;
    const span = this.host.child(this.parentId, name, KIND_INTERNAL, attrs, options.attributes);
    return new Step(this.host, span);
  }
}

/** One agent turn: the root span of a trace. */
export class Turn extends Scope {
  /** 32 lowercase hex: a fresh trace per turn, never the visit's, so this span is the run's root. */
  readonly traceId = newTraceId();
  /** @internal */
  readonly signal: AbortSignal | undefined;
  /** @internal */
  readonly defaults: Pick<TurnOptions, 'provider' | 'model'>;
  protected readonly host: Turn = this;
  private readonly root: Draft;
  private readonly correlation: Attrs = {};
  private readonly spans: Draft[] = [];
  private done = false;

  constructor(
    private readonly agents: Agents,
    options: TurnOptions,
  ) {
    super();
    this.signal = options.signal;
    this.defaults = { provider: options.provider, model: options.model };
    const found = options.spine && ('spine' in options.spine ? options.spine.spine : options.spine);
    const ids: Record<string, string | undefined> = {
      'argos.session_id': options.sessionId ?? found?.sessionId,
      'argos.anon_id': options.anonId ?? found?.anonId,
      'argos.user_id': options.userId ?? found?.userId,
      'argos.account_id': options.accountId ?? found?.accountId,
    };
    for (const [key, id] of Object.entries(ids)) if (id) this.correlation[key] = str(id);

    const attrs: Attrs = {
      ...this.correlation,
      'gen_ai.operation.name': str('invoke_agent'),
      'gen_ai.agent.name': str(options.agent),
    };
    this.root = draft(this.traceId, `invoke_agent ${options.agent}`, KIND_INTERNAL, {
      ...this.agents.custom(options.attributes),
      ...identity(options.provider, options.model),
      ...attrs,
    });
  }

  protected get parentId(): string {
    return this.root.spanId;
  }

  /**
   * Runs `fn` as the whole turn: it ends `completed` when `fn` resolves,
   * `cancelled` on an abort, `failed` otherwise. The error is rethrown untouched.
   */
  run<T>(fn: (turn: this) => T | PromiseLike<T>): Promise<T> {
    return observe(
      this.signal,
      () => fn(this),
      () => {
        this.end();
      },
      (error, cancelled) => {
        this.end(cancelled ? { outcome: 'cancelled' } : { outcome: 'failed', error });
      },
    );
  }

  /** Exports the turn. A call still open is closed now and its own later `end` is ignored; so is a second turn `end`. */
  end(end: TurnEnd = {}): void {
    if (this.done) return;
    this.done = true;
    this.agents.attempt(() => {
      const outcome = end.outcome ?? (end.error === undefined ? 'completed' : 'failed');
      const now = Date.now();
      for (const span of this.spans) span.endMs ??= now;
      this.root.endMs = now;
      this.root.attrs['argos.run.outcome'] = str(outcome);
      if (outcome === 'failed') fail(this.root, end.error);
      else if (outcome === 'completed') this.root.status = { code: STATUS_OK };
      else if (end.reason) {
        this.root.attrs['argos.run.cancel_reason'] = str(end.reason.slice(0, TEXT_CAP));
      }
      this.messages(this.root.attrs, end);
    });
    this.agents.accept([this.root, ...this.spans]);
  }

  /** @internal */
  settle(span: Draft, error: unknown, fill: (attrs: Attrs) => void): void {
    if (span.endMs !== undefined) return;
    span.endMs = Date.now();
    this.agents.attempt(() => {
      if (error !== undefined) fail(span, error);
      fill(span.attrs);
    });
  }

  /** @internal */
  attempt<T>(fn: () => T): T | undefined {
    return this.agents.attempt(fn);
  }

  /** @internal */
  get capturing(): boolean {
    return this.agents.captureContent;
  }

  /** @internal */
  messages(attrs: Attrs, { input, output }: { input?: unknown; output?: unknown }): void {
    this.content(attrs, 'gen_ai.input.messages', input);
    this.content(attrs, 'gen_ai.output.messages', output);
  }

  /** @internal */
  content(attrs: Attrs, key: string, value: unknown): void {
    if (!this.capturing || value === undefined) return;
    const text = capped(value, CONTENT_CAP);
    if (text) attrs[key] = text;
  }

  /** @internal */
  child(parentId: string, name: string, kind: number, attrs: Attrs, custom?: Attributes): Draft {
    const span = draft(
      this.traceId,
      name,
      kind,
      { ...this.agents.custom(custom), ...this.correlation, ...attrs },
      parentId,
    );
    this.spans.push(span);
    return span;
  }
}

export class ModelCall {
  constructor(
    private readonly turn: Turn,
    private readonly span: Draft,
  ) {}

  end(end: ModelEnd = {}): void {
    this.turn.settle(this.span, end.error, (attrs) => {
      if (end.responseModel) attrs['gen_ai.response.model'] = str(end.responseModel);
      for (const [key, name] of USAGE) {
        const count = end[key];
        if (typeof count === 'number') attrs[name] = int(count);
      }
      if (typeof end.costUsd === 'number' && Number.isFinite(end.costUsd) && end.costUsd >= 0) {
        attrs['gen_ai.usage.cost'] = dbl(end.costUsd);
      }
      this.turn.messages(attrs, end);
    });
  }

  /** Runs `fn` as this call; `usageOf` reads the usage off its result. A throw is rethrown untouched. */
  run<T>(fn: () => T | PromiseLike<T>, usageOf?: (result: T) => ModelEnd): Promise<T> {
    return observe(
      this.turn.signal,
      fn,
      (result) => {
        // usageOf is caller code: a throw there must not cost the caller its result.
        this.end(this.turn.attempt(() => usageOf?.(result)) ?? {});
      },
      (error, cancelled) => {
        this.end(cancelled ? {} : { error });
      },
    );
  }
}

export class Step extends Scope {
  constructor(
    protected readonly host: Turn,
    private readonly span: Draft,
  ) {
    super();
  }

  protected get parentId(): string {
    return this.span.spanId;
  }

  /** A child still open when its step ends keeps running until it ends or the turn does. */
  end(end: StepEnd = {}): void {
    this.host.settle(this.span, end.error, (attrs) => {
      this.host.messages(attrs, end);
    });
  }

  /** Runs `fn` as this step: a throw fails it, an abort leaves it cancelled; the error is rethrown untouched. */
  run<T>(fn: (step: this) => T | PromiseLike<T>): Promise<T> {
    return observe(
      this.host.signal,
      () => fn(this),
      () => {
        this.end();
      },
      (error, cancelled) => {
        this.end(cancelled ? {} : { error });
      },
    );
  }
}

export class ToolCall {
  constructor(
    private readonly turn: Turn,
    private readonly span: Draft,
  ) {}

  end(end: ToolEnd = {}): void {
    this.turn.settle(this.span, end.error, (attrs) => {
      this.turn.content(attrs, 'gen_ai.tool.call.arguments', end.arguments);
      this.turn.content(attrs, 'gen_ai.tool.call.result', end.result);
    });
  }

  /** Runs `fn` as this call; `arguments` and `resultOf` record its content. A throw is rethrown untouched. */
  run<T>(fn: () => T | PromiseLike<T>, options: ToolRun<T> = {}): Promise<T> {
    return observe(
      this.turn.signal,
      fn,
      (result) => {
        // resultOf is caller code: a throw there must not cost the caller its result.
        const recorded = this.turn.capturing
          ? this.turn.attempt(() => options.resultOf?.(result))
          : undefined;
        this.end({ arguments: options.arguments, result: recorded });
      },
      (error, cancelled) => {
        this.end({ arguments: options.arguments, ...(cancelled ? {} : { error }) });
      },
    );
  }
}

export function initAgents(options: AgentsOptions): Agents {
  return new Agents(options);
}
