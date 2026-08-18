/**
 * Noticing a publish without a webhook.
 *
 * Webhooks are better: they arrive at once and cost nothing while nothing is
 * happening. But they need the CMS to be able to reach *you*, and plenty of
 * places cannot be reached — a development machine behind a router, a private
 * network, anywhere without a public address. Polling the manifest is the
 * fallback, and it is cheap: one request that answers 304 with no body until
 * somebody publishes.
 *
 * This is for a long-lived process. It is not for a Worker or a Lambda, where
 * a timer does not outlive the request that started it.
 */

import type { CmsClient } from './client.js';
import type { Manifest } from './types.js';

export interface WatchOptions {
  /**
   * How often to ask, in milliseconds. Default 60 000 — a minute is polite.
   * Anything under a second, or not a number, falls back to the default.
   */
  intervalMs?: number;
  /**
   * The version you already have. Without it the first poll sets the baseline
   * quietly, so starting the watcher does not look like a publish.
   */
  since?: number;
  /** Stop when this aborts. */
  signal?: AbortSignal;
  /**
   * Poll immediately as well as on the interval. Default true — otherwise a
   * publish during startup is missed for a full interval.
   */
  immediate?: boolean;
  /**
   * Where polling failures go. Without it they are swallowed: an unreachable
   * CMS must not kill a watcher that will succeed again in a minute.
   */
  onError?: (error: unknown) => void;
}

export type StopWatching = () => void;

/**
 * Call `onChange` whenever the site's content version moves.
 *
 * Returns a function that stops the watching. `onChange` is awaited, so a slow
 * handler delays the next poll rather than overlapping with itself.
 *
 * Delivery is at least once: a version counts as seen only after `onChange`
 * resolves, so a handler that throws is called again with the same publish on
 * the next poll rather than losing it. Make the handler idempotent — it is
 * usually a deploy, and a deploy run twice is better than one never run.
 */
export function watchContent(
  client: CmsClient,
  options: WatchOptions,
  onChange: (manifest: Manifest) => void | Promise<void>,
): StopWatching {
  // A non-number here would reach `setTimeout` as NaN, which means "now" —
  // turning a polite poll into a tight loop against somebody's CMS.
  const requested = Number(options.intervalMs ?? 60_000);
  const interval = Number.isFinite(requested) && requested >= 1000 ? requested : 60_000;
  let lastSeen = options.since;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop: StopWatching = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  };

  // A signal that has already aborted will never dispatch the event again, so
  // the listener below would never fire and the watcher would poll for ever.
  if (options.signal?.aborted) {
    stopped = true;
    return stop;
  }

  options.signal?.addEventListener('abort', stop, { once: true });

  const tick = async () => {
    if (stopped) return;

    try {
      const manifest = await client.manifest({ signal: options.signal });

      if (lastSeen === undefined) {
        // The quiet first poll: a baseline, not a publish.
        lastSeen = manifest.contentVersion;
      } else if (manifest.contentVersion !== lastSeen) {
        // Recorded only once the handler has actually dealt with it. A handler
        // that throws gets the same version again next tick instead of the
        // publish being marked seen and lost.
        await onChange(manifest);
        lastSeen = manifest.contentVersion;
      }
    } catch (error) {
      if (!stopped) options.onError?.(error);
    }

    // Scheduled after the work, never during it, so a poll that takes longer
    // than the interval cannot pile up behind itself.
    if (!stopped) timer = setTimeout(tick, interval);
  };

  if (options.immediate === false) {
    timer = setTimeout(tick, interval);
  } else {
    void tick();
  }

  return stop;
}
