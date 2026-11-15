// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAgents, spineFrom, type AgentsOptions } from '../src/agents/index.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@ingest.example.com/42';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const SESSION = '0192f3a7-1c2e-7c31-9a1e-6f0b8c2d4e5a';
const ANON = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
}
interface Request {
  resourceSpans: {
    resource: { attributes: Span['attributes'] };
    scopeSpans: { scope: { name: string }; spans: Span[] }[];
  }[];
}

let calls: { url: string; init: RequestInit; body: Request }[] = [];
let respond: () => Response;

function attrs(list: Span['attributes']): Record<string, unknown> {
  return Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
}
function spansOf(call = 0): Span[] {
  return calls[call]?.body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}
function named(prefix: string, call = 0): Span {
  const span = spansOf(call).find((s) => s.name.startsWith(prefix));
  if (!span) throw new Error(`no span starting with ${prefix}`);
  return span;
}
function agents(extra: Partial<AgentsOptions> = {}) {
  return initAgents({
    dsn: DSN,
    environment: 'staging',
    release: '1.4.0',
    heartbeat: false,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  calls = [];
  respond = () => new Response('{}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(init.body as string) as Request });
      return Promise.resolve(respond());
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the wire shape', () => {
  it('posts OTLP/JSON to the traces endpoint with the project key', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end();
    expect(await a.flush()).toBe(true);

    expect(calls[0]?.url).toBe('https://ingest.example.com/api/42/v1/traces');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Argos-Key']).toBe('0123456789abcdef0123456789abcdef');
  });

  it('describes the process on the resource', async () => {
    const a = agents({ serviceName: 'tasky-worker' });
    a.turn({ agent: 'tasky' }).end();
    await a.flush();

    const resource = attrs(calls[0]?.body.resourceSpans[0]?.resource.attributes ?? []);
    expect(resource).toMatchObject({
      'service.name': 'tasky-worker',
      'service.version': '1.4.0',
      'deployment.environment.name': 'staging',
      'telemetry.sdk.language': 'nodejs',
    });
  });

  it('emits hex ids, nanosecond strings and one trace for the whole turn', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    vi.setSystemTime(NOW + 5);
    turn.model({ provider: 'anthropic', model: 'claude-x' }).end();
    vi.setSystemTime(NOW + 20);
    turn.tool({ name: 'search' }).end();
    turn.end();
    await a.flush();

    const spans = spansOf();
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.traceId).toBe(turn.traceId);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    }
    const root = named('invoke_agent');
    expect(root.parentSpanId).toBeUndefined();
    expect(root.startTimeUnixNano).toBe((BigInt(NOW) * 1_000_000n).toString());
    expect(root.endTimeUnixNano).toBe((BigInt(NOW + 20) * 1_000_000n).toString());
    expect(named('chat').parentSpanId).toBe(root.spanId);
    expect(named('chat').startTimeUnixNano).toBe((BigInt(NOW + 5) * 1_000_000n).toString());
    expect(named('execute_tool').parentSpanId).toBe(root.spanId);
  });

  it('names and types each span the way the server reads them', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky', model: 'claude-x' });
    turn
      .model({ provider: 'anthropic', model: 'claude-x' })
      .end({ responseModel: 'claude-x-0925' });
    turn.tool({ name: 'search' }).end();
    turn.end();
    await a.flush();

    expect(attrs(named('invoke_agent tasky').attributes)).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'tasky',
      'gen_ai.request.model': 'claude-x',
    });
    expect(attrs(named('chat claude-x').attributes)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-x',
      'gen_ai.response.model': 'claude-x-0925',
    });
    expect(attrs(named('execute_tool search').attributes)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search',
    });
  });

  it('gives every span a gen_ai attribute, or the server drops it silently', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'p', model: 'm' }).end({ error: new Error('x') });
    turn.tool({ name: 't' }).end({ error: new Error('x') });
    turn.model({ provider: 'p', model: 'left open' });
    turn.end({ outcome: 'cancelled' });
    await a.flush();

    expect(spansOf()).toHaveLength(4);
    for (const span of spansOf()) {
      expect(span.attributes.some(({ key }) => key.startsWith('gen_ai.'))).toBe(true);
    }
  });
});

describe('token accounting', () => {
  it('keeps cached and reasoning tokens as subsets, never adding them', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'anthropic', model: 'm' }).end({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 600,
      cacheWriteTokens: 100,
      reasoningOutputTokens: 50,
      costUsd: 0.0123,
    });
    turn.end();
    await a.flush();

    expect(named('chat').attributes).toEqual(
      expect.arrayContaining([
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '1000' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '200' } },
        { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '600' } },
        { key: 'gen_ai.usage.cache_creation.input_tokens', value: { intValue: '100' } },
        { key: 'gen_ai.usage.reasoning.output_tokens', value: { intValue: '50' } },
        { key: 'gen_ai.usage.cost', value: { doubleValue: 0.0123 } },
      ]),
    );
  });

  it('reports no cost unless the caller has one', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'p', model: 'm' }).end({ inputTokens: 5, outputTokens: 1 });
    turn.end();
    await a.flush();

    expect(attrs(named('chat').attributes)).not.toHaveProperty('gen_ai.usage.cost');
  });

  it('sends a bad count as zero rather than something the server cannot parse', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'p', model: 'm' }).end({ inputTokens: Number.NaN, outputTokens: -3 });
    turn.end();
    await a.flush();

    expect(attrs(named('chat').attributes)).toMatchObject({
      'gen_ai.usage.input_tokens': '0',
      'gen_ai.usage.output_tokens': '0',
    });
  });
});

describe('outcomes', () => {
  it('marks a completed turn on the root', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end();
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('completed');
    expect(named('invoke_agent').status.code).toBe(1);
  });

  it('fails a turn with an error status and its message', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end({ error: new TypeError('boom') });
    await a.flush();

    const root = named('invoke_agent');
    expect(attrs(root.attributes)['argos.run.outcome']).toBe('failed');
    expect(root.status).toEqual({ code: 2, message: 'boom' });
  });

  it('does not make a cancelled turn an error', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end({ outcome: 'cancelled' });
    await a.flush();

    const root = named('invoke_agent');
    expect(attrs(root.attributes)['argos.run.outcome']).toBe('cancelled');
    expect(root.status.code).toBe(0);
  });

  it('records a throw as failed and rethrows it untouched', async () => {
    const a = agents();
    const boom = new Error('provider down');

    await expect(
      a.turn({ agent: 'tasky' }).run(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('failed');
  });

  it('treats an AbortError as cancelled, in the turn and in the call under it', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const abort = new DOMException('cut', 'AbortError');

    await expect(
      turn.run((t) =>
        t.tool({ name: 'search' }).run(() => {
          throw abort;
        }),
      ),
    ).rejects.toBe(abort);
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('cancelled');
    expect(named('invoke_agent').status.code).toBe(0);
    expect(named('execute_tool').status.code).toBe(0);
  });

  it('treats an aborted signal as cancelled even when the error is custom', async () => {
    const a = agents();
    const controller = new AbortController();
    const reason = new Error('supervisor cut');
    controller.abort(reason);

    await expect(
      a.turn({ agent: 'tasky', signal: controller.signal }).run(() => Promise.reject(reason)),
    ).rejects.toBe(reason);
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('cancelled');
  });

  it('keeps a timeout a failure', async () => {
    const a = agents();
    const signal = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));

    await a
      .turn({ agent: 'tasky', signal })
      .run(() => {
        throw signal.reason;
      })
      .catch(() => undefined);
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('failed');
  });

  it('fails a model call that throws and keeps the turn going', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    await turn
      .model({ provider: 'p', model: 'm' })
      .run(() => Promise.reject(new Error('429')))
      .catch(() => undefined);
    turn.end();
    await a.flush();

    expect(named('chat').status).toEqual({ code: 2, message: '429' });
    expect(attrs(named('chat').attributes)['error.type']).toBe('Error');
  });

  it('reads usage off the result of a wrapped model call', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const reply = await turn.model({ provider: 'p', model: 'm' }).run(
      () => ({ text: 'hi', usage: { in: 12, out: 3 } }),
      (r) => ({ inputTokens: r.usage.in, outputTokens: r.usage.out }),
    );
    turn.end();
    await a.flush();

    expect(reply.text).toBe('hi');
    expect(attrs(named('chat').attributes)['gen_ai.usage.input_tokens']).toBe('12');
  });

  it('closes a call left open when the turn ends, and ignores a second end', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.tool({ name: 'slow' });
    turn.end();
    turn.end({ error: new Error('late') });
    await a.flush();

    expect(spansOf()).toHaveLength(2);
    expect(attrs(named('invoke_agent').attributes)['argos.run.outcome']).toBe('completed');
  });

  it('ignores the end of a call whose turn already ended', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const tool = turn.tool({ name: 'slow' });
    turn.end();
    await a.flush();
    tool.end();
    tool.end();
    await a.flush();

    expect(calls).toHaveLength(1);
  });
});

describe('content', () => {
  const content = {
    input: [{ role: 'user', content: 'the secret prompt' }],
    output: [{ role: 'assistant', content: 'the secret answer' }],
  };

  async function run(options: Partial<AgentsOptions>): Promise<string> {
    const a = agents(options);
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'p', model: 'm' }).end(content);
    turn.tool({ name: 't' }).end({ arguments: { q: 'secret arg' }, result: 'secret result' });
    turn.end();
    await a.flush();
    return JSON.stringify(calls[0]?.body);
  }

  it('is stripped before it leaves when captureContent is false', async () => {
    const body = await run({ captureContent: false });

    expect(body).not.toContain('secret');
    expect(body).not.toContain('gen_ai.input.messages');
    expect(body).not.toContain('gen_ai.tool.call');
  });

  it('is sent as JSON strings by default', async () => {
    await run({});

    expect(attrs(named('chat').attributes)).toMatchObject({
      'gen_ai.input.messages': JSON.stringify(content.input),
      'gen_ai.output.messages': JSON.stringify(content.output),
    });
    expect(attrs(named('execute_tool').attributes)).toMatchObject({
      'gen_ai.tool.call.arguments': '{"q":"secret arg"}',
      'gen_ai.tool.call.result': '"secret result"',
    });
  });

  it('sends nothing the caller did not pass', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model({ provider: 'p', model: 'm' }).end({ inputTokens: 1 });
    turn.tool({ name: 't' }).end();
    turn.end();
    await a.flush();

    const body = JSON.stringify(calls[0]?.body);
    expect(body).not.toContain('gen_ai.input.messages');
    expect(body).not.toContain('gen_ai.tool.call');
  });

  it('truncates what it sends and survives content that cannot be serialized', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    turn.model({ provider: 'p', model: 'm' }).end({ input: 'x'.repeat(50_000), output: circular });
    turn.end();
    await a.flush();

    const sent = attrs(named('chat').attributes);
    expect(String(sent['gen_ai.input.messages']).length).toBe(8192);
    expect(sent).not.toHaveProperty('gen_ai.output.messages');
  });
});

describe('custom attributes', () => {
  it('carries them on the span they were given to, typed for the wire', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky', attributes: { 'tasky.run_id': 'r_1', trigger: 'cron' } });
    turn.model({ provider: 'p', model: 'm', attributes: { attempt: 2, ratio: 0.5, cached: true } });
    turn.tool({ name: 't', attributes: { 'tasky.board': 'b_9' } }).end();
    turn.end();
    await a.flush();

    expect(named('invoke_agent').attributes).toEqual(
      expect.arrayContaining([
        { key: 'tasky.run_id', value: { stringValue: 'r_1' } },
        { key: 'trigger', value: { stringValue: 'cron' } },
      ]),
    );
    expect(named('chat').attributes).toEqual(
      expect.arrayContaining([
        { key: 'attempt', value: { intValue: '2' } },
        { key: 'ratio', value: { doubleValue: 0.5 } },
        { key: 'cached', value: { boolValue: true } },
      ]),
    );
    expect(attrs(named('execute_tool').attributes)).toMatchObject({ 'tasky.board': 'b_9' });
    expect(attrs(named('execute_tool').attributes)).not.toHaveProperty('tasky.run_id');
  });

  it('never lets them override what the SDK owns, and says so under debug', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const a = agents({ debug: true });
    const turn = a.turn({
      agent: 'tasky',
      sessionId: SESSION,
      attributes: {
        'gen_ai.operation.name': 'hijack',
        'gen_ai.usage.input_tokens': 999,
        'argos.session_id': 'forged',
        'argos.run.outcome': 'completed',
        'argos.custom': 'x',
        'error.type': 'forged',
        kept: 'yes',
      },
    });
    turn.end({ outcome: 'cancelled' });
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'argos.session_id': SESSION,
      'argos.run.outcome': 'cancelled',
      kept: 'yes',
    });
    const sent = attrs(named('invoke_agent').attributes);
    for (const key of ['gen_ai.usage.input_tokens', 'argos.custom', 'error.type']) {
      expect(sent).not.toHaveProperty(key);
    }
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"argos.custom" dropped: reserved'));
  });

  it('caps the count and the lengths, and drops values it cannot encode', async () => {
    const a = agents();
    const many: Record<string, string | number | boolean> = {};
    for (let i = 0; i < 40; i++) many[`k${String(i)}`] = i;
    const turn = a.turn({ agent: 'tasky', attributes: many });
    turn.tool({
      name: 't',
      attributes: {
        long: 'x'.repeat(2_000),
        ['y'.repeat(129)]: 'long key',
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        nested: {} as unknown as string,
        ok: 'fine',
      },
    });
    turn.end();
    await a.flush();

    const root = attrs(named('invoke_agent').attributes);
    expect(Object.keys(root).filter((k) => /^k\d+$/.test(k))).toHaveLength(32);
    const tool = attrs(named('execute_tool').attributes);
    expect(String(tool['long'])).toHaveLength(512);
    expect(tool).toMatchObject({ ok: 'fine' });
    for (const key of ['nan', 'inf', 'nested', 'y'.repeat(129)])
      expect(tool).not.toHaveProperty(key);
  });

  it('keeps a hostile attributes value from breaking the turn', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky', attributes: 'nope' as unknown as never });
    turn.end();
    await a.flush();

    expect(spansOf()).toHaveLength(1);
  });
});

describe('cancel reason and turn content', () => {
  it('records why a turn was cancelled, cut at 256 characters', async () => {
    const a = agents();
    a.turn({ agent: 'one' }).end({ outcome: 'cancelled', reason: 'user pressed stop' });
    a.turn({ agent: 'two' }).end({ outcome: 'cancelled', reason: 'r'.repeat(400) });
    a.turn({ agent: 'three' }).end({ outcome: 'cancelled' });
    await a.flush();

    expect(attrs(named('invoke_agent one').attributes)['argos.run.cancel_reason']).toBe(
      'user pressed stop',
    );
    expect(attrs(named('invoke_agent two').attributes)['argos.run.cancel_reason']).toHaveLength(
      256,
    );
    expect(attrs(named('invoke_agent three').attributes)).not.toHaveProperty(
      'argos.run.cancel_reason',
    );
  });

  it('ignores a reason on a turn that was not cancelled', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end({ reason: 'stray' });
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)).not.toHaveProperty('argos.run.cancel_reason');
  });

  it('puts the turn input and output on the root, capped and gated like the rest', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end({ input: 'make a task', output: { id: 7 } });
    a.turn({ agent: 'big' }).end({ input: 'x'.repeat(50_000) });
    await a.flush();

    expect(attrs(named('invoke_agent tasky').attributes)).toMatchObject({
      'gen_ai.input.messages': '"make a task"',
      'gen_ai.output.messages': '{"id":7}',
    });
    expect(
      String(attrs(named('invoke_agent big').attributes)['gen_ai.input.messages']),
    ).toHaveLength(8192);
  });

  it('strips the turn content when captureContent is false', async () => {
    const a = agents({ captureContent: false });
    a.turn({ agent: 'tasky' }).end({ input: 'secret in', output: 'secret out' });
    await a.flush();

    expect(JSON.stringify(calls[0]?.body)).not.toContain('secret');
  });
});

describe('inherited provider and model', () => {
  it('uses the turn defaults and lets a call override them', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky', provider: 'anthropic', model: 'claude-x' });
    turn.model().end();
    turn.model({ model: 'claude-y' }).end();
    turn.model({ provider: 'openai', model: 'gpt-z', operation: 'embeddings' }).end();
    turn.end();
    await a.flush();

    expect(attrs(named('chat claude-x').attributes)).toMatchObject({
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-x',
    });
    expect(attrs(named('chat claude-y').attributes)).toMatchObject({
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-y',
    });
    expect(attrs(named('embeddings gpt-z').attributes)).toMatchObject({
      'gen_ai.provider.name': 'openai',
    });
  });

  it('still emits a span with an operation when nothing names a model', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.model().end();
    turn.end();
    await a.flush();

    expect(named('chat').name).toBe('chat');
    expect(attrs(named('chat').attributes)).not.toHaveProperty('gen_ai.request.model');
    expect(attrs(named('chat').attributes)['gen_ai.operation.name']).toBe('chat');
  });
});

describe('tool content from run()', () => {
  it('records the arguments and the mapped result without a manual end()', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const result = await turn.tool({ name: 'create_task' }).run(() => ({ id: 7, big: 'x' }), {
      arguments: { title: 'ship' },
      resultOf: (r) => ({ id: r.id }),
    });
    turn.end();
    await a.flush();

    expect(result).toEqual({ id: 7, big: 'x' });
    expect(attrs(named('execute_tool').attributes)).toMatchObject({
      'gen_ai.tool.call.arguments': '{"title":"ship"}',
      'gen_ai.tool.call.result': '{"id":7}',
    });
  });

  it('sends no result unless resultOf names one, and keeps the arguments on a failure', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    await turn.tool({ name: 'ok' }).run(() => 'raw', { arguments: { q: 1 } });
    await turn
      .tool({ name: 'bad' })
      .run(() => Promise.reject(new Error('nope')), { arguments: { q: 2 } })
      .catch(() => undefined);
    turn.end();
    await a.flush();

    expect(attrs(named('execute_tool ok').attributes)).not.toHaveProperty(
      'gen_ai.tool.call.result',
    );
    expect(attrs(named('execute_tool bad').attributes)).toMatchObject({
      'gen_ai.tool.call.arguments': '{"q":2}',
    });
    expect(named('execute_tool bad').status.code).toBe(2);
  });

  it('keeps a throwing resultOf from costing the caller its result, and honors captureContent', async () => {
    const a = agents({ captureContent: false });
    const turn = a.turn({ agent: 'tasky' });
    const got = await turn.tool({ name: 't' }).run(() => 'reply', {
      arguments: 'secret',
      resultOf: () => {
        throw new Error('bad mapper');
      },
    });
    turn.end();
    await a.flush();

    expect(got).toBe('reply');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('secret');
  });
});

describe('steps', () => {
  it('emits a step with gen_ai.operation.name, the step name and the turn as parent', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.step({ name: 'human_approval', attributes: { channel: 'slack' } }).end({
      input: 'delete 3 tasks?',
      output: 'approved',
    });
    turn.end();
    await a.flush();

    const step = named('step human_approval');
    expect(step.parentSpanId).toBe(named('invoke_agent').spanId);
    expect(step.kind).toBe(1);
    expect(attrs(step.attributes)).toMatchObject({
      'gen_ai.operation.name': 'step',
      'argos.step.name': 'human_approval',
      channel: 'slack',
      'gen_ai.input.messages': '"delete 3 tasks?"',
      'gen_ai.output.messages': '"approved"',
    });
  });

  it('nests: a step holds model, tool and step children with the right parents', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky', provider: 'anthropic', model: 'claude-x' });
    await turn.step({ name: 'subagent' }).run(async (outer) => {
      outer.model().end();
      await outer.tool({ name: 'search' }).run(() => 'r');
      await outer.step({ name: 'inner' }).run((inner) => {
        inner.tool({ name: 'deep' }).end();
      });
    });
    turn.tool({ name: 'top' }).end();
    turn.end();
    await a.flush();

    const root = named('invoke_agent').spanId;
    const outer = named('step subagent').spanId;
    const inner = named('step inner').spanId;
    expect(named('step subagent').parentSpanId).toBe(root);
    expect(named('chat').parentSpanId).toBe(outer);
    expect(named('execute_tool search').parentSpanId).toBe(outer);
    expect(named('step inner').parentSpanId).toBe(outer);
    expect(named('execute_tool deep').parentSpanId).toBe(inner);
    expect(named('execute_tool top').parentSpanId).toBe(root);
    expect(attrs(named('chat').attributes)['gen_ai.request.model']).toBe('claude-x');
    expect(spansOf()).toHaveLength(7);
    for (const span of spansOf()) {
      expect(span.attributes.some(({ key }) => key.startsWith('gen_ai.'))).toBe(true);
    }
  });

  it('fails a step that throws, leaves an abort cancelled, and rethrows untouched', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const boom = new Error('retrieval down');
    await expect(
      turn.step({ name: 'retrieval' }).run(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await turn
      .step({ name: 'cut' })
      .run(() => {
        throw new DOMException('cut', 'AbortError');
      })
      .catch(() => undefined);
    turn.end();
    await a.flush();

    expect(named('step retrieval').status).toEqual({ code: 2, message: 'retrieval down' });
    expect(named('step cut').status.code).toBe(0);
  });

  it('closes a step left open with the turn, and strips its content like the rest', async () => {
    const a = agents({ captureContent: false });
    const turn = a.turn({ agent: 'tasky' });
    const step = turn.step({ name: 'wait' });
    turn.end();
    step.end({ input: 'secret' });
    await a.flush();

    expect(spansOf()).toHaveLength(2);
    expect(JSON.stringify(calls[0]?.body)).not.toContain('secret');
  });
});

describe('bounded flush', () => {
  // A fetch that never answers on its own, like a dead connection: only an abort ends it.
  function hang(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            calls.push({ url, init, body: JSON.parse(init.body as string) as Request });
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
  }

  it('resolves false at the deadline and keeps the spans for the next flush', async () => {
    hang();
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    turn.tool({ name: 't' }).end();
    turn.end();

    const bounded = a.flush({ timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await bounded).toBe(false);
    expect(calls).toHaveLength(1);

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init, body: JSON.parse(init.body as string) as Request });
        return Promise.resolve(new Response('{}'));
      }),
    );
    expect(await a.flush()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(spansOf(1).map((span) => span.name)).toEqual(
      expect.arrayContaining(['execute_tool t', 'invoke_agent tasky']),
    );
    expect(spansOf(1)).toHaveLength(2);
  });

  it('resolves true when delivery beats the deadline', async () => {
    const a = agents();
    a.turn({ agent: 'tasky' }).end();

    expect(await a.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('keeps the spans too when the deadline hits before the send even starts', async () => {
    hang();
    const a = agents();
    a.turn({ agent: 'one' }).end();
    const first = a.flush({ timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    a.turn({ agent: 'two' }).end();
    const second = a.flush({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await first).toBe(false);
    expect(await second).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init, body: JSON.parse(init.body as string) as Request });
        return Promise.resolve(new Response('{}'));
      }),
    );
    expect(await a.flush()).toBe(true);
    const last = calls.length - 1;
    expect(spansOf(last).map((span) => span.name)).toEqual([
      'invoke_agent one',
      'invoke_agent two',
    ]);
  });

  it('aborts one request that never answers and retries it', async () => {
    hang();
    const a = agents();
    a.turn({ agent: 'tasky' }).end();
    const flushed = a.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init, body: JSON.parse(init.body as string) as Request });
        return Promise.resolve(new Response('{}'));
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await flushed).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('correlation', () => {
  it('joins the visit it was started from, without borrowing its trace', async () => {
    const a = agents();
    const spine = spineFrom({
      traceparent: `00-${TRACE}-${SPAN}-01`,
      baggage: `argos.session_id=${SESSION},argos.anon_id=${ANON},argos.user_id=u_1,argos.account_id=acct_7`,
    });
    const turn = a.turn({ agent: 'tasky', ...(spine ? { spine } : {}) });
    turn.tool({ name: 'search' }).end();
    turn.end();
    await a.flush();

    for (const span of spansOf()) {
      expect(attrs(span.attributes)).toMatchObject({
        'argos.session_id': SESSION,
        'argos.anon_id': ANON,
        'argos.user_id': 'u_1',
        'argos.account_id': 'acct_7',
      });
      // A fresh trace keeps this span the root of its run: the server reads a
      // run's status off the span with no parent.
      expect(span.traceId).not.toBe(TRACE);
    }
    expect(named('invoke_agent').parentSpanId).toBeUndefined();
  });

  it('lets explicit ids win over the spine and works with no spine at all', async () => {
    const a = agents();
    a.turn({
      agent: 'tasky',
      spine: {
        traceId: TRACE,
        parentSpanId: SPAN,
        sessionId: SESSION,
        anonId: ANON,
        userId: 'u_1',
      },
      userId: 'u_2',
    }).end();
    a.turn({ agent: 'cron' }).end();
    await a.flush();

    const roots = spansOf().filter((span) => span.name.startsWith('invoke_agent'));
    expect(attrs(roots[0]?.attributes ?? [])).toMatchObject({
      'argos.user_id': 'u_2',
      'argos.session_id': SESSION,
    });
    expect(attrs(roots[1]?.attributes ?? [])).not.toHaveProperty('argos.session_id');
  });

  it('accepts a Visit-shaped object carrying a spine', async () => {
    const a = agents();
    const spine = { traceId: TRACE, parentSpanId: SPAN, sessionId: SESSION, anonId: ANON };
    a.turn({ agent: 'tasky', spine: { spine } }).end();
    await a.flush();

    expect(attrs(named('invoke_agent').attributes)['argos.session_id']).toBe(SESSION);
  });
});

describe('delivery', () => {
  it('sends nothing for nothing, and sends on a timer when nobody flushes', async () => {
    const a = agents();
    expect(await a.flush()).toBe(true);
    expect(calls).toEqual([]);

    a.turn({ agent: 'tasky' }).end();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toHaveLength(1);
  });

  it('reports a delivery that was given up on', async () => {
    respond = () => new Response('bad key', { status: 401 });
    const a = agents();
    a.turn({ agent: 'tasky' }).end();

    expect(await a.flush()).toBe(false);
  });

  it('logs the spans the server rejected, so a drop is not silent', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    respond = () =>
      new Response(
        JSON.stringify({ partialSuccess: { rejectedSpans: '2', errorMessage: 'no id' } }),
      );
    const a = agents({ debug: true });
    a.turn({ agent: 'tasky' }).end();

    expect(await a.flush()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('server rejected 2 span(s): no id'));
  });

  it('bounds the queue and counts what it dropped', async () => {
    const a = agents();
    for (let i = 0; i < 600; i++) {
      const turn = a.turn({ agent: `a${String(i)}` });
      turn.tool({ name: 't' }).end();
      turn.end();
    }
    await a.flush();

    expect(a.dropped).toBe(200);
    expect(calls.flatMap((_, i) => spansOf(i))).toHaveLength(1000);
    expect(calls.every((_, i) => spansOf(i).length <= 100)).toBe(true);
  });

  it('serializes flushes so a second one waits for the first', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = fetch;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      calls.length === 0 ? gate.then(() => original(url, init)) : original(url, init),
    );
    const a = agents();
    a.turn({ agent: 'one' }).end();
    const first = a.flush();
    await vi.advanceTimersByTimeAsync(0);
    a.turn({ agent: 'two' }).end();
    const second = a.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);

    release();

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toHaveLength(2);
  });
});

describe('never throws into the host', () => {
  it('survives an unreachable server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const a = agents();
    a.turn({ agent: 'tasky' }).end();
    const flushed = a.flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await flushed).toBe(false);
  });

  it('is inert, not broken, when the DSN is wrong', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = initAgents({ dsn: 'not a dsn' });
    const turn = a.turn({ agent: 'tasky' });

    expect(() => {
      turn.model({ provider: 'p', model: 'm' }).end({ inputTokens: 1 });
      turn.end();
    }).not.toThrow();
    expect(await a.flush()).toBe(true);
    expect(calls).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it('keeps a throwing usage reader from costing the caller its result', async () => {
    const a = agents();
    const turn = a.turn({ agent: 'tasky' });
    const result = await turn.model({ provider: 'p', model: 'm' }).run(
      () => 'reply',
      () => {
        throw new Error('bad reader');
      },
    );

    expect(result).toBe('reply');
  });
});
