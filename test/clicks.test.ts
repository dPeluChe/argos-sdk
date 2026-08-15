import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickTracker, eventFrom } from '../src/clicks.js';
import { close, init } from '../src/index.js';
import type { ArgosEvent, EventBatch } from '../src/types.js';

const DSN = 'https://a1b2c3@ingest.argos.dev/42';

let fetchMock: ReturnType<typeof vi.fn>;

function sent(): ArgosEvent[] {
  return fetchMock.mock.calls.flatMap((call) => {
    const url = call[0] as string;
    if (!url.includes('/events/')) return [];
    return (JSON.parse((call[1] as RequestInit).body as string) as EventBatch).events;
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

describe('reading the event off an element', () => {
  it('takes the name from the attribute and the props from the prefix', () => {
    const button = document.createElement('button');
    button.setAttribute('data-argos-event', 'signup_clicked');
    button.setAttribute('data-argos-event-plan', 'pro');
    button.setAttribute('data-argos-event-position', 'header');
    button.setAttribute('data-other', 'ignored');

    expect(eventFrom(button)).toEqual({
      name: 'signup_clicked',
      props: { plan: 'pro', position: 'header' },
    });
  });

  it('ignores an element with no name, so a stray prop cannot invent an event', () => {
    const div = document.createElement('div');
    div.setAttribute('data-argos-event-plan', 'pro');

    expect(eventFrom(div)).toBeUndefined();
  });

  it('ignores a name that is only whitespace', () => {
    const div = document.createElement('div');
    div.setAttribute('data-argos-event', '   ');

    expect(eventFrom(div)).toBeUndefined();
  });
});

describe('tracking a click', () => {
  it('reports the marked element when the click lands on a child of it', async () => {
    document.body.innerHTML =
      '<button data-argos-event="cta_clicked" data-argos-event-plan="pro">' +
      '<span id="label">Buy</span></button>';
    const client = init({ dsn: DSN, autoClicks: true });

    document.getElementById('label')?.click();
    await client?.flush();

    expect(sent().map((event) => [event.name, event.props])).toEqual([
      ['cta_clicked', { plan: 'pro' }],
    ]);
  });

  it('stays silent on an unmarked click', async () => {
    document.body.innerHTML = '<button id="plain">Buy</button>';
    const client = init({ dsn: DSN, autoClicks: true });

    document.getElementById('plain')?.click();
    await client?.flush();

    expect(sent()).toEqual([]);
  });

  it('is off unless asked for, so upgrading sends nothing new', async () => {
    document.body.innerHTML = '<button data-argos-event="cta_clicked">Buy</button>';
    const client = init({ dsn: DSN });

    document.querySelector('button')?.click();
    await client?.flush();

    expect(sent()).toEqual([]);
  });

  // A menu or modal that stops propagation is ordinary application code, and it
  // must not silently delete the event. This is why the listener captures.
  it('still reports when a handler above it stops propagation', async () => {
    document.body.innerHTML =
      '<div id="menu"><button data-argos-event="menu_item_clicked">Go</button></div>';
    document.getElementById('menu')?.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    const client = init({ dsn: DSN, autoClicks: true });

    document.querySelector('button')?.click();
    await client?.flush();

    expect(sent().map((event) => event.name)).toEqual(['menu_item_clicked']);
  });

  it('never cancels the click it observes', () => {
    document.body.innerHTML = '<button data-argos-event="cta_clicked">Buy</button>';
    init({ dsn: DSN, autoClicks: true });

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.querySelector('button')?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
  });

  it('stops listening after close, rather than leaking onto the next client', () => {
    document.body.innerHTML = '<button data-argos-event="cta_clicked">Buy</button>';
    init({ dsn: DSN, autoClicks: true });
    close();

    document.querySelector('button')?.click();

    expect(sent()).toEqual([]);
  });
});

describe('the caps that keep one bad element from poisoning a batch', () => {
  it('truncates a name past the column width', () => {
    const div = document.createElement('div');
    div.setAttribute('data-argos-event', 'x'.repeat(500));

    expect(eventFrom(div)?.name).toHaveLength(200);
  });

  it('keeps the first twenty props and drops the rest rather than the event', () => {
    const div = document.createElement('div');
    div.setAttribute('data-argos-event', 'noisy');
    for (let index = 0; index < 40; index += 1) {
      div.setAttribute(`data-argos-event-k${String(index)}`, 'v');
    }

    const found = eventFrom(div);

    expect(found?.name).toBe('noisy');
    expect(Object.keys(found?.props ?? {})).toHaveLength(20);
  });
});

describe('starting twice', () => {
  it('does not double-report, because start is idempotent', () => {
    document.body.innerHTML = '<button data-argos-event="cta_clicked">Buy</button>';
    const events: string[] = [];
    const tracker = new ClickTracker((name) => events.push(name));

    tracker.start();
    tracker.start();
    document.querySelector('button')?.click();
    tracker.stop();

    expect(events).toEqual(['cta_clicked']);
  });
});
