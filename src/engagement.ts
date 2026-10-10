export interface EngagementReport {
  engaged_ms: number;
  /** 0-100 */
  scroll_depth: number;
}

const MIN_REPORT_MS = 1_000;

/** Visible, focused time on the current page, reported as deltas. See docs/DEVELOPMENT.md. */
export class EngagementTracker {
  private activeSince: number | undefined;
  private pending = 0;
  private maxScroll = 0;
  private reportedScroll = 0;
  private detach: (() => void) | undefined;

  constructor(
    private readonly report: (report: EngagementReport) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.detach) return;
    const doc = globalThis.document as Document | undefined;
    if (!doc) return;
    const sync = (): void => {
      this.sync();
    };
    const onScroll = (): void => {
      this.readScroll();
    };
    doc.addEventListener('visibilitychange', sync);
    globalThis.addEventListener('focus', sync);
    globalThis.addEventListener('blur', sync);
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    this.detach = () => {
      doc.removeEventListener('visibilitychange', sync);
      globalThis.removeEventListener('focus', sync);
      globalThis.removeEventListener('blur', sync);
      globalThis.removeEventListener('scroll', onScroll);
    };
    this.sync();
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
    this.activeSince = undefined;
  }

  /** A new page; flush the previous one first. */
  begin(): void {
    this.pending = 0;
    this.maxScroll = 0;
    this.reportedScroll = 0;
    this.activeSince = undefined;
    this.readScroll();
    this.sync();
  }

  flush(): void {
    this.pause();
    if (this.pending >= MIN_REPORT_MS || this.maxScroll > this.reportedScroll) {
      this.report({ engaged_ms: Math.round(this.pending), scroll_depth: this.maxScroll });
      this.pending = 0;
      this.reportedScroll = this.maxScroll;
    }
    this.sync();
  }

  private sync(): void {
    if (active()) {
      this.activeSince ??= this.now();
    } else {
      this.pause();
    }
  }

  private pause(): void {
    if (this.activeSince === undefined) return;
    this.pending += Math.max(0, this.now() - this.activeSince);
    this.activeSince = undefined;
  }

  private readScroll(): void {
    const doc = globalThis.document as Document | undefined;
    const height = doc?.documentElement.scrollHeight ?? 0;
    if (height <= 0) return;
    const seen = (globalThis.scrollY || 0) + (globalThis.innerHeight || 0);
    const depth = Math.min(100, Math.round((seen / height) * 100));
    if (depth > this.maxScroll) this.maxScroll = depth;
  }
}

function active(): boolean {
  const doc = globalThis.document as Document | undefined;
  if (!doc || doc.visibilityState !== 'visible') return false;
  return typeof doc.hasFocus !== 'function' || doc.hasFocus();
}
