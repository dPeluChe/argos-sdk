import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InteractionTracker,
  LayoutShiftWindows,
  rate,
  VitalsCollector,
  type VitalReport,
} from '../src/vitals.js';

type Handler = (list: { getEntries: () => PerformanceEntry[] }) => void;

class FakeObserver {
  static instances: FakeObserver[] = [];
  static unsupported = new Set<string>();
  type: string | undefined;
  durationThreshold: number | undefined;
  disconnected = false;

  constructor(private readonly handler: Handler) {
    FakeObserver.instances.push(this);
  }

  observe(init: { type: string; durationThreshold?: number }): void {
    if (FakeObserver.unsupported.has(init.type)) throw new TypeError('unsupported entry type');
    this.type = init.type;
    this.durationThreshold = init.durationThreshold;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  deliver(entries: unknown[]): void {
    this.handler({ getEntries: () => entries as PerformanceEntry[] });
  }
}

function emit(type: string, entries: unknown[]): void {
  for (const observer of FakeObserver.instances) {
    if (observer.type === type && !observer.disconnected) observer.deliver(entries);
  }
}

function collect(): { reports: VitalReport[]; collector: VitalsCollector } {
  const reports: VitalReport[] = [];
  const collector = new VitalsCollector((report) => reports.push(report));
  collector.start();
  return { reports, collector };
}

const shift = (value: number, startTime: number, hadRecentInput = false): unknown => ({
  value,
  startTime,
  hadRecentInput,
});

describe('rate', () => {
  it('uses the published thresholds, inclusive on the good bound', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 2501)).toBe('needs-improvement');
    expect(rate('CLS', 0.3)).toBe('poor');
    expect(rate('INP', 200)).toBe('good');
    expect(rate('TTFB', 1801)).toBe('poor');
  });
});

describe('LayoutShiftWindows', () => {
  it('accumulates inside one session window', () => {
    const windows = new LayoutShiftWindows();
    windows.add(0.05, 1000);
    windows.add(0.05, 1500);
    windows.add(0.02, 2000);
    expect(windows.max).toBeCloseTo(0.12, 5);
  });

  it('starts a new window after a gap over one second', () => {
    const windows = new LayoutShiftWindows();
    windows.add(0.1, 1000);
    windows.add(0.3, 2100);
    windows.add(0.05, 2500);
    expect(windows.max).toBeCloseTo(0.35, 5);
  });

  it('starts a new window past five seconds even without a gap', () => {
    const windows = new LayoutShiftWindows();
    for (let at = 0; at <= 6000; at += 500) windows.add(0.01, at);
    expect(windows.max).toBeCloseTo(0.1, 5);
  });

  it('reports the worst window, not the page total', () => {
    const windows = new LayoutShiftWindows();
    windows.add(0.4, 0);
    windows.add(0.1, 3000);
    windows.add(0.1, 6000);
    expect(windows.max).toBeCloseTo(0.4, 5);
  });
});

describe('InteractionTracker', () => {
  it('takes the worst interaction on a quiet page', () => {
    const tracker = new InteractionTracker();
    tracker.add(1, 80);
    tracker.add(2, 240);
    tracker.add(3, 120);
    expect(tracker.value).toBe(240);
  });

  it('keeps the longest duration seen for one interaction id', () => {
    const tracker = new InteractionTracker();
    tracker.add(1, 90);
    tracker.add(1, 150);
    tracker.add(1, 100);
    expect(tracker.value).toBe(150);
  });

  it('steps one rank down per fifty interactions', () => {
    const tracker = new InteractionTracker();
    for (let id = 1; id <= 120; id++) tracker.add(id, id);
    // 120 interactions: rank 2 of the ten longest — 120, 119, 118.
    expect(tracker.value).toBe(118);
  });

  it('is undefined with no interactions', () => {
    expect(new InteractionTracker().value).toBeUndefined();
  });
});

describe('VitalsCollector', () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    FakeObserver.unsupported = new Set();
    vi.stubGlobal('PerformanceObserver', FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports FCP and TTFB once, on finalize', () => {
    const { reports, collector } = collect();
    emit('paint', [
      { name: 'first-paint', startTime: 400 },
      { name: 'first-contentful-paint', startTime: 900 },
    ]);
    emit('navigation', [{ responseStart: 120.6 }]);
    expect(reports).toEqual([]);

    collector.finalize();
    expect(reports).toEqual([
      { metric: 'CLS', value: 0, rating: 'good' },
      { metric: 'FCP', value: 900, rating: 'good' },
      { metric: 'TTFB', value: 121, rating: 'good' },
    ]);
    collector.stop();
  });

  it('keeps the last LCP candidate and freezes it on the first input', () => {
    const { reports, collector } = collect();
    emit('largest-contentful-paint', [{ startTime: 1200 }]);
    emit('largest-contentful-paint', [{ startTime: 2400 }]);
    globalThis.dispatchEvent(new Event('pointerdown'));
    emit('largest-contentful-paint', [{ startTime: 9000 }]);

    collector.finalize();
    expect(reports).toEqual([
      { metric: 'LCP', value: 2400, rating: 'good' },
      { metric: 'CLS', value: 0, rating: 'good' },
    ]);
    collector.stop();
  });

  it('finalizes LCP on page hide when no input ever happened', () => {
    const { reports, collector } = collect();
    emit('largest-contentful-paint', [{ startTime: 4200 }]);
    collector.finalize();
    emit('largest-contentful-paint', [{ startTime: 9000 }]);
    collector.finalize();

    expect(reports).toEqual([
      { metric: 'LCP', value: 4200, rating: 'poor' },
      { metric: 'CLS', value: 0, rating: 'good' },
    ]);
    collector.stop();
  });

  it('reports each metric exactly once across repeated finalize calls', () => {
    const { reports, collector } = collect();
    emit('paint', [{ name: 'first-contentful-paint', startTime: 800 }]);
    emit('layout-shift', [shift(0.05, 1000)]);
    emit('event', [{ interactionId: 4, duration: 300 }]);

    collector.finalize();
    collector.finalize();
    collector.finalize();

    expect(reports.map((report) => report.metric)).toEqual(['CLS', 'INP', 'FCP']);
    collector.stop();
  });

  it('accumulates CLS in session windows and ignores input-driven shifts', () => {
    const { reports, collector } = collect();
    emit('layout-shift', [shift(0.05, 1000), shift(0.05, 1400)]);
    emit('layout-shift', [shift(0.3, 4000), shift(0.9, 4200, true)]);
    collector.finalize();

    expect(reports).toEqual([{ metric: 'CLS', value: 0.3, rating: 'poor' }]);
    collector.stop();
  });

  it('reports a CLS of zero when nothing shifted', () => {
    const { reports, collector } = collect();
    collector.finalize();
    expect(reports).toEqual([{ metric: 'CLS', value: 0, rating: 'good' }]);
    collector.stop();
  });

  it('feeds INP from event and first-input entries above the duration threshold', () => {
    const { reports, collector } = collect();
    const eventObserver = FakeObserver.instances.find((each) => each.type === 'event');
    expect(eventObserver?.durationThreshold).toBe(40);

    emit('first-input', [{ interactionId: 1, duration: 90 }]);
    emit('event', [
      { interactionId: 1, duration: 90 },
      { interactionId: 2, duration: 560 },
      { interactionId: 0, duration: 4000 },
    ]);
    collector.finalize();

    expect(reports).toContainEqual({ metric: 'INP', value: 560, rating: 'poor' });
    collector.stop();
  });

  it('degrades silently when an entry type is unsupported', () => {
    FakeObserver.unsupported = new Set(['event', 'first-input', 'layout-shift']);
    const { reports, collector } = collect();
    emit('paint', [{ name: 'first-contentful-paint', startTime: 700 }]);
    collector.finalize();

    expect(reports.map((report) => report.metric)).toEqual(['FCP']);
    collector.stop();
  });

  it('does nothing at all without PerformanceObserver', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const reports: VitalReport[] = [];
    const collector = new VitalsCollector((report) => reports.push(report));

    expect(() => {
      collector.start();
      collector.finalize();
      collector.stop();
    }).not.toThrow();
    expect(reports).toEqual([]);
  });

  it('disconnects every observer on stop', () => {
    const { collector } = collect();
    expect(FakeObserver.instances.length).toBeGreaterThan(0);
    collector.stop();
    expect(FakeObserver.instances.every((each) => each.disconnected)).toBe(true);
  });

  it('never lets a broken entry escape into the page', () => {
    const { reports, collector } = collect();
    expect(() => {
      emit('layout-shift', [
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('detached entry');
            },
          },
        ),
      ]);
    }).not.toThrow();
    collector.finalize();
    expect(reports).toEqual([{ metric: 'CLS', value: 0, rating: 'good' }]);
    collector.stop();
  });
});
