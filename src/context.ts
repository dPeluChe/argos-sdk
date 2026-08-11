import type { Props } from './types.js';

const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

/**
 * Ad-network click ids. Deliberately its own list, not the pageview ignore list:
 * that one answers "is this the same page", this one "where did the visit come
 * from", and `ignoreParams` may replace it. See docs/DEVELOPMENT.md.
 */
const AD_CLICK_IDS = ['gclid', 'fbclid', 'msclkid', 'ttclid', 'twclid', 'yclid'] as const;

const MAX_VALUE_LENGTH = 200;

function param(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value.slice(0, MAX_VALUE_LENGTH) : undefined;
}

/**
 * Campaign tags of the current URL, absent when absent — never an empty string.
 * Reporting them is not the same job as identifying a page: `pageKey()` still
 * strips them, and must keep doing so.
 */
export function campaignProps(search: string): Props {
  const params = new URLSearchParams(search);
  const props: Props = {};
  for (const name of CAMPAIGN_PARAMS) {
    const value = param(params, name);
    if (value !== undefined) props[name] = value;
  }
  // The network name, never the click id itself: enough to keep an auto-tagged
  // paid visit from reading as direct, without storing a per-click identifier.
  const network = AD_CLICK_IDS.find((name) => param(params, name) !== undefined);
  if (network) props.click_id_source = network;
  return props;
}

/** What only the browser knows: no request header carries screen or viewport. */
export function browserProps(): Props {
  const props: Props = {};
  const screen = globalThis.screen as Screen | undefined;
  if (typeof screen?.width === 'number' && typeof screen.height === 'number') {
    props.screen_width = Math.round(screen.width);
    props.screen_height = Math.round(screen.height);
  }
  const view = globalThis as { innerWidth?: number; innerHeight?: number };
  if (typeof view.innerWidth === 'number' && typeof view.innerHeight === 'number') {
    props.viewport_width = Math.round(view.innerWidth);
    props.viewport_height = Math.round(view.innerHeight);
  }
  const language = (globalThis.navigator as Navigator | undefined)?.language;
  if (language) props.language = language.slice(0, MAX_VALUE_LENGTH);
  return props;
}
