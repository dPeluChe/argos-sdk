import { createStore, type KeyValueStore } from './storage.js';
import type { DeprecationOptions, Props } from './types.js';

/**
 * Two captureros, one per world of warning:
 *
 * - `ReportingObserver` sees what the browser engine deprecates — the only
 *   channel those warnings exist in, and the one carrying the removal date.
 * - the `console.warn` wrapper sees what libraries emit — a CDN script has no
 *   way to report its own deprecation except by writing to the console.
 *
 * Everything passes through the client's own consent gate; nothing here sends
 * on its own. The wire contract is `docs/INGEST_API.md` (workspace): kind
 * `deprecation`, name `deprecation`, fixed-shape props.
 */

/** The same net the server classifies with (argos-workers,
 * `internal/deprecation`): lowercase literals, because everything the wild
 * sends is a plain phrase. The client filter saves the round trip; the server
 * still decides. */
const BUILTIN_PATTERNS = [
  'deprecat',
  'will be removed',
  'no longer supported',
  'sunset',
  'obsolete',
];

const SEEN_KEY = 'argos.deprecations.seen';
const SEEN_MAX = 50;
const MESSAGE_MAX = 2_000;

/** Returns the pattern that fired, or undefined for an ordinary warning. */
export function matchPattern(text: string, extra: readonly string[] = []): string | undefined {
  const lower = text.toLowerCase();
  for (const pattern of [...BUILTIN_PATTERNS, ...extra]) {
    if (pattern && lower.includes(pattern.toLowerCase())) return pattern;
  }
  return undefined;
}

/**
 * Once per signature per tab session. A condemned CDN warns on every page
 * load, and the server groups by message anyway: the first sighting is the
 * signal, the thousandth is noise. `sessionStorage` clears with the tab, so a
 * fresh visit reports again — which is also how the registry learns the
 * warning is still alive.
 */
class Throttle {
  private readonly store: KeyValueStore;
  private readonly seen = new Set<string>();

  constructor(store: KeyValueStore) {
    this.store = store;
    for (const signature of readSignatures(store)) this.seen.add(signature);
  }

  claim(signature: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    // A tab session outliving fifty distinct warnings has bigger problems;
    // drop-oldest keeps the storage bounded either way.
    const all = [...this.seen].slice(-SEEN_MAX);
    this.seen.clear();
    for (const item of all) this.seen.add(item);
    this.store.set(SEEN_KEY, JSON.stringify(all));
    return true;
  }
}

function readSignatures(store: KeyValueStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.get(SEEN_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Renders a console argument for matching: objects JSON'd, everything long
 * clipped — matching needs a phrase, not the whole payload. */
function render(arg: unknown): string {
  const text = typeof arg === 'string' ? arg : safeJson(arg);
  return text.slice(0, MESSAGE_MAX);
}

function safeJson(value: unknown): string {
  try {
    // stringify answers undefined for undefined and functions; both render.
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

interface ReportLike {
  type: string;
  url?: string;
  body?: {
    id?: string;
    message?: string;
    sourceFile?: string;
    lineNumber?: number;
    /** When the browser plans to remove the API. A date, epoch millis, or
     *  nothing announced: the three shapes seen in the wild. */
    anticipatedRemoval?: Date | number | string | null;
  } | null;
}

interface ObserverLike {
  observe(): void;
  disconnect(): void;
}

type ObserverCtor = new (
  callback: (reports: ReportLike[]) => void,
  options: { types?: string[]; buffered?: boolean },
) => ObserverLike;

export class DeprecationCollector {
  private readonly patterns: readonly string[];
  private readonly watchReports: boolean;
  private readonly watchConsole: boolean;
  private readonly throttle: Throttle;
  private observer: ObserverLike | undefined;
  private originalWarn: ((...args: unknown[]) => void) | undefined;

  constructor(
    private readonly emit: (props: Props) => void,
    options: DeprecationOptions = {},
  ) {
    this.patterns = options.patterns ?? [];
    this.watchReports = options.observer !== false;
    this.watchConsole = options.console !== false;
    this.throttle = new Throttle(createStore('sessionStorage'));
  }

  start(): void {
    if (this.watchReports) this.watchObserver();
    if (this.watchConsole) this.wrapConsole();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.originalWarn) console.warn = this.originalWarn;
    this.originalWarn = undefined;
  }

  private watchObserver(): void {
    const Ctor = (globalThis as { ReportingObserver?: ObserverCtor }).ReportingObserver;
    if (!Ctor) return; // Firefox: nothing to watch, a declared gap
    this.observer = new Ctor(
      (reports) => {
        for (const report of reports) {
          if (report.type !== 'deprecation') continue;
          const body = report.body;
          const message = body?.message;
          if (!message) continue;
          const feature = body.id ?? '';
          if (!this.throttle.claim(`ro:${feature}:${message.slice(0, 80)}`)) continue;
          const props: Props = {
            message: message.slice(0, MESSAGE_MAX),
            origin: 'reporting-observer',
            url: report.url || locationOf(),
          };
          if (feature) props.feature = feature;
          if (body.sourceFile) props.source_file = body.sourceFile;
          if (typeof body.lineNumber === 'number') props.line = body.lineNumber;
          const removal = removalDate(body.anticipatedRemoval);
          if (removal) props.anticipate_removal = removal;
          this.emit(props);
        }
      },
      // `buffered` replays what fired before init ran — early warnings are
      // usually the ones that matter, thrown by the first script tags.
      { types: ['deprecation'], buffered: true },
    );
    this.observer.observe();
  }

  private wrapConsole(): void {
    this.originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      // The page's console stays exactly as it was; the capture is a
      // side effect, never a replacement.
      this.originalWarn?.(...args);
      const message = args.map(render).join(' ');
      const pattern = matchPattern(message, this.patterns);
      if (!pattern) return;
      if (!this.throttle.claim(`console:${pattern}:${message.slice(0, 80)}`)) return;
      this.emit({
        message: message.slice(0, MESSAGE_MAX),
        origin: 'console',
        pattern,
        url: locationOf(),
      });
    };
  }
}

function locationOf(): string | undefined {
  const loc = globalThis.location as Location | undefined;
  return loc?.href;
}

function removalDate(value: Date | number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}
