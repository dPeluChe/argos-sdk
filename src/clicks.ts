import type { Props } from './types.js';

/** The attribute that names the event, and the prefix its props come from. */
export const EVENT_ATTRIBUTE = 'data-argos-event';
const PROP_PREFIX = 'data-argos-event-';

/** Wire limits, matched to the product event contract so a value that would be
 *  truncated server-side is truncated here instead of arriving surprising. */
const MAX_NAME = 200;
const MAX_VALUE = 500;
/** A dataset with fifty keys is a mistake, not instrumentation. Extra keys are
 *  dropped rather than the whole event, which would lose the click entirely. */
const MAX_PROPS = 20;

/**
 * Reads the event off one element. Exported for the test and for callers who
 * dispatch clicks themselves — a framework that swallows the real event can
 * still hand its node here.
 */
export function eventFrom(element: Element): { name: string; props: Props } | undefined {
  const name = element.getAttribute(EVENT_ATTRIBUTE)?.trim().slice(0, MAX_NAME);
  if (!name) return undefined;

  const props: Props = {};
  let count = 0;
  for (const attribute of Array.from(element.attributes)) {
    if (!attribute.name.startsWith(PROP_PREFIX)) continue;
    const key = attribute.name.slice(PROP_PREFIX.length);
    if (!key || count >= MAX_PROPS) continue;
    props[key] = attribute.value.slice(0, MAX_VALUE);
    count += 1;
  }
  return { name, props };
}

/**
 * Click tracking without writing JavaScript for each event: mark the element
 * and it reports itself.
 *
 * One delegated listener rather than one per element, because the elements a
 * single-page app cares about are mounted and unmounted constantly and a
 * per-element listener would need a mutation observer to keep up — and would
 * leak the ones it missed.
 *
 * The listener is passive and never calls preventDefault. An analytics
 * listener that can cancel a click can break a checkout button, and a
 * navigation that leaves the page is covered by the unload flush the transport
 * already installs.
 */
export class ClickTracker {
  private listener: ((event: Event) => void) | undefined;

  constructor(private readonly emit: (name: string, props: Props) => void) {}

  start(): void {
    if (this.listener) return;
    const target = globalThis.document as Document | undefined;
    if (!target) return;

    this.listener = (event: Event) => {
      this.capture(event);
    };
    // Capture phase: a handler that stops propagation on the way up — common in
    // menus and modals — would otherwise silently delete the event.
    target.addEventListener('click', this.listener, { capture: true, passive: true });
  }

  stop(): void {
    if (!this.listener) return;
    (globalThis.document as Document | undefined)?.removeEventListener('click', this.listener, {
      capture: true,
    });
    this.listener = undefined;
  }

  private capture(event: Event): void {
    const start = event.target;
    if (!(start instanceof Element)) return;

    // Nearest marked ancestor, so marking a button still reports when the click
    // lands on the icon or the text node inside it.
    const marked = start.closest(`[${EVENT_ATTRIBUTE}]`);
    if (!marked) return;

    const found = eventFrom(marked);
    if (found) this.emit(found.name, found.props);
  }
}
