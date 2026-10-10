import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngagementTracker, type EngagementReport } from '../src/engagement.js';

let clock = 0;
let visible: DocumentVisibilityState = 'visible';
let focused = true;

function newTracker(): { tracker: EngagementTracker; reports: EngagementReport[] } {
  const reports: EngagementReport[] = [];
  const tracker = new EngagementTracker(
    (report) => reports.push(report),
    () => clock,
  );
  tracker.start();
  tracker.begin();
  return { tracker, reports };
}

function setVisibility(state: DocumentVisibilityState): void {
  visible = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function setFocus(value: boolean): void {
  focused = value;
  globalThis.dispatchEvent(new Event(value ? 'focus' : 'blur'));
}

beforeEach(() => {
  clock = 0;
  visible = 'visible';
  focused = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EngagementTracker', () => {
  it('reports the visible, focused time since the page began', () => {
    const { tracker, reports } = newTracker();
    clock = 4_200;
    tracker.flush();
    expect(reports).toHaveLength(1);
    expect(reports[0].engaged_ms).toBe(4_200);
    tracker.stop();
  });

  it('stops the clock while the tab is hidden or the window is not focused', () => {
    const { tracker, reports } = newTracker();
    clock = 2_000;
    setVisibility('hidden');
    clock = 60_000;
    setVisibility('visible');
    clock = 63_000;
    setFocus(false);
    clock = 600_000;
    setFocus(true);
    clock = 601_000;
    tracker.flush();
    expect(reports.map((r) => r.engaged_ms)).toEqual([6_000]);
    tracker.stop();
  });

  it('sends deltas, so a later flush reports only what came after the previous one', () => {
    const { tracker, reports } = newTracker();
    clock = 3_000;
    tracker.flush();
    clock = 5_500;
    tracker.flush();
    expect(reports.map((r) => r.engaged_ms)).toEqual([3_000, 2_500]);
    tracker.stop();
  });

  it('drops a glance under one second with no new scroll', () => {
    const { tracker, reports } = newTracker();
    clock = 400;
    tracker.flush();
    expect(reports).toHaveLength(0);
    tracker.stop();
  });

  it('starts every page from zero', () => {
    const { tracker, reports } = newTracker();
    clock = 400;
    tracker.begin();
    clock = 1_400;
    tracker.flush();
    expect(reports.map((r) => r.engaged_ms)).toEqual([1_000]);
    tracker.stop();
  });

  it('records the deepest scroll seen and reports when it grows', () => {
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(2_000);
    vi.stubGlobal('innerHeight', 500);
    vi.stubGlobal('scrollY', 0);
    const { tracker, reports } = newTracker();
    vi.stubGlobal('scrollY', 1_000);
    globalThis.dispatchEvent(new Event('scroll'));
    vi.stubGlobal('scrollY', 200);
    globalThis.dispatchEvent(new Event('scroll'));
    clock = 100;
    tracker.flush();
    expect(reports).toEqual([{ engaged_ms: 100, scroll_depth: 75 }]);
    tracker.stop();
    vi.unstubAllGlobals();
  });
});
