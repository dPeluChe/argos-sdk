export type VitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalReport {
  metric: VitalName;
  value: number;
  rating: VitalRating;
}

/** Google's published thresholds: [good, needs-improvement] upper bounds. */
const THRESHOLDS: Record<VitalName, readonly [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

const CLS_GAP_MS = 1000;
const CLS_WINDOW_MS = 5000;
/** Below this the interaction is imperceptible; the spec's own floor for `event` entries. */
const INP_DURATION_THRESHOLD_MS = 40;
const INP_MAX_CANDIDATES = 10;

export function rate(metric: VitalName, value: number): VitalRating {
  const [good, poor] = THRESHOLDS[metric];
  if (value <= good) return 'good';
  return value <= poor ? 'needs-improvement' : 'poor';
}

interface LayoutShiftEntry {
  startTime: number;
  value: number;
  hadRecentInput: boolean;
}

interface InteractionEntry {
  duration: number;
  interactionId?: number;
}

interface NavigationEntry {
  responseStart: number;
}

/**
 * CLS is the worst *session window*, not the page total: shifts group while they
 * stay within 1s of each other and 5s of the window start.
 */
export class LayoutShiftWindows {
  private current = 0;
  private firstAt = 0;
  private lastAt = 0;
  max = 0;

  add(value: number, at: number): void {
    const continues =
      this.current > 0 && at - this.lastAt < CLS_GAP_MS && at - this.firstAt < CLS_WINDOW_MS;
    if (continues) {
      this.current += value;
    } else {
      this.current = value;
      this.firstAt = at;
    }
    this.lastAt = at;
    this.max = Math.max(this.max, this.current);
  }
}

/**
 * INP is the worst interaction on quiet pages and roughly the 98th percentile on
 * busy ones: keep the ten longest and step one rank down per 50 interactions.
 */
export class InteractionTracker {
  private readonly longest: { id: number; duration: number }[] = [];
  private readonly seen = new Set<number>();

  add(id: number, duration: number): void {
    this.seen.add(id);
    const known = this.longest.find((candidate) => candidate.id === id);
    if (known) {
      known.duration = Math.max(known.duration, duration);
    } else {
      this.longest.push({ id, duration });
    }
    this.longest.sort((a, b) => b.duration - a.duration);
    this.longest.length = Math.min(this.longest.length, INP_MAX_CANDIDATES);
  }

  get value(): number | undefined {
    if (this.longest.length === 0) return undefined;
    const rank = Math.min(this.longest.length - 1, Math.floor(this.seen.size / 50));
    return this.longest[rank].duration;
  }
}

interface ObserveInit {
  type: string;
  buffered: boolean;
  durationThreshold?: number;
}

function round(metric: VitalName, value: number): number {
  return metric === 'CLS' ? Math.round(value * 10_000) / 10_000 : Math.round(value);
}

/**
 * Collects the five Core Web Vitals from `PerformanceObserver` and reports each
 * one exactly once, when `finalize()` runs on page hide.
 */
export class VitalsCollector {
  private readonly observers: PerformanceObserver[] = [];
  private readonly detach: (() => void)[] = [];
  private readonly supported = new Set<string>();
  private readonly reported = new Set<VitalName>();
  private readonly shifts = new LayoutShiftWindows();
  private readonly interactions = new InteractionTracker();
  private lcp = 0;
  private lcpSettled = false;
  private fcp: number | undefined;
  private ttfb: number | undefined;

  constructor(private readonly emit: (report: VitalReport) => void) {}

  start(): void {
    this.observe('largest-contentful-paint', (entries) => {
      if (this.lcpSettled) return;
      const last = entries.at(-1);
      if (last) this.lcp = Math.max(this.lcp, last.startTime);
    });

    this.observe('layout-shift', (entries) => {
      for (const entry of entries as unknown as LayoutShiftEntry[]) {
        if (!entry.hadRecentInput) this.shifts.add(entry.value, entry.startTime);
      }
    });

    for (const type of ['event', 'first-input']) {
      this.observe(
        type,
        (entries) => {
          for (const entry of entries as unknown as InteractionEntry[]) {
            const id = entry.interactionId ?? 0;
            if (id > 0) this.interactions.add(id, entry.duration);
          }
        },
        INP_DURATION_THRESHOLD_MS,
      );
    }

    this.observe('paint', (entries) => {
      for (const entry of entries) {
        if (entry.name === 'first-contentful-paint') this.fcp ??= entry.startTime;
      }
    });

    this.observe('navigation', (entries) => {
      const first = entries[0] as unknown as NavigationEntry | undefined;
      if (first) this.ttfb ??= first.responseStart;
    });

    this.onFirstInput();
  }

  /** LCP stops growing at the first interaction: what the user saw before touching the page. */
  private onFirstInput(): void {
    const settle = (): void => {
      this.lcpSettled = true;
    };
    for (const type of ['keydown', 'click', 'pointerdown']) {
      try {
        globalThis.addEventListener(type, settle, { once: true, capture: true });
        this.detach.push(() => {
          globalThis.removeEventListener(type, settle, { capture: true });
        });
      } catch {
        // No window: LCP simply settles on page hide instead.
      }
    }
  }

  private observe(
    type: string,
    handle: (entries: PerformanceEntry[]) => void,
    durationThreshold?: number,
  ): void {
    const Observer = globalThis.PerformanceObserver as typeof PerformanceObserver | undefined;
    if (typeof Observer !== 'function') return;
    try {
      const observer = new Observer((list) => {
        try {
          handle(list.getEntries());
        } catch {
          // A malformed entry must never surface inside the host page.
        }
      });
      const init: ObserveInit = { type, buffered: true };
      if (durationThreshold !== undefined) init.durationThreshold = durationThreshold;
      observer.observe(init);
      this.observers.push(observer);
      this.supported.add(type);
    } catch {
      // Unsupported entry type — Safari has no `event` timing. Degrade silently.
    }
  }

  /** Reports every metric measured so far. Safe to call twice: nothing is reported twice. */
  finalize(): void {
    this.lcpSettled = true;
    if (this.lcp > 0) this.report('LCP', this.lcp);
    if (this.supported.has('layout-shift')) this.report('CLS', this.shifts.max);
    const inp = this.interactions.value;
    if (inp !== undefined) this.report('INP', inp);
    if (this.fcp !== undefined) this.report('FCP', this.fcp);
    if (this.ttfb !== undefined) this.report('TTFB', this.ttfb);
  }

  stop(): void {
    for (const observer of this.observers) {
      try {
        observer.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.observers.length = 0;
    for (const step of this.detach) step();
    this.detach.length = 0;
  }

  private report(metric: VitalName, value: number): void {
    if (this.reported.has(metric)) return;
    this.reported.add(metric);
    const rounded = round(metric, value);
    this.emit({ metric, value: rounded, rating: rate(metric, rounded) });
  }
}
