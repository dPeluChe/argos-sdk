import type { AutoPageviewOptions, Props } from './types.js';

/** Campaign and click-id parameters: they change the URL without changing the page. */
const DEFAULT_IGNORED_PARAMS = [
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'twclid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  '_ga',
];

function isIgnored(name: string, ignored: string[]): boolean {
  return name.startsWith('utm_') || ignored.includes(name);
}

/**
 * The page identity: pathname plus the query parameters that select content,
 * sorted so a reordering is not a new page. See docs/DEVELOPMENT.md.
 */
export function pageKey(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  options: AutoPageviewOptions = {},
): string {
  const ignored = options.ignoreParams ?? DEFAULT_IGNORED_PARAMS;
  const kept = [...new URLSearchParams(location.search).entries()]
    .filter(([name]) => !isIgnored(name, ignored))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';
  const hash = options.hashMode === true ? location.hash : '';
  return `${location.pathname}${search}${hash}`;
}

type HistoryMethod = 'pushState' | 'replaceState';

/** Patches the SPA navigation entry points. Returns the undo — never leave a patched history behind. */
function patchHistory(onNavigate: () => void): () => void {
  const undo: (() => void)[] = [];
  const history = globalThis.history as History | undefined;

  for (const name of ['pushState', 'replaceState'] as const satisfies HistoryMethod[]) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied on the real `this`
    const original = history?.[name];
    if (!history || typeof original !== 'function') continue;
    try {
      history[name] = function patched(this: History, ...args: Parameters<History[HistoryMethod]>) {
        original.apply(this, args);
        onNavigate();
      };
      undo.push(() => {
        history[name] = original;
      });
    } catch {
      // Some embedded webviews freeze `history`. Losing SPA pageviews beats throwing.
    }
  }

  try {
    const onPopstate = (): void => {
      onNavigate();
    };
    globalThis.addEventListener('popstate', onPopstate);
    undo.push(() => {
      globalThis.removeEventListener('popstate', onPopstate);
    });
  } catch {
    // No window: nothing to listen on.
  }

  return () => {
    for (const step of undo) {
      try {
        step();
      } catch {
        // Best effort: an undo that throws must not stop the others.
      }
    }
  };
}

/** Emits a pageview on load and on every SPA navigation that lands on a different page. */
export class PageviewTracker {
  private previous: string | undefined;
  private restore: (() => void) | undefined;

  constructor(
    private readonly emit: (props: Props) => void,
    private readonly options: AutoPageviewOptions = {},
  ) {}

  start(): void {
    if (this.restore) return;
    this.restore = patchHistory(() => {
      this.capture();
    });
    this.capture();
  }

  stop(): void {
    this.restore?.();
    this.restore = undefined;
    this.previous = undefined;
  }

  /** No-op when the page identity matches the previous one — a router may navigate to itself. */
  capture(): void {
    const location = globalThis.location as Location | undefined;
    if (!location) return;
    const key = pageKey(location, this.options);
    if (key === this.previous) return;

    const document = globalThis.document as Document | undefined;
    const props: Props = { path: key };
    if (document?.title) props.title = document.title;
    // `document.referrer` never changes on SPA navigation: repeating it would
    // make every route change look like it arrived from the external source.
    if (this.previous === undefined) {
      if (document?.referrer) props.referrer = document.referrer;
    } else {
      props.previous_path = this.previous;
    }

    this.previous = key;
    this.emit(props);
  }
}
