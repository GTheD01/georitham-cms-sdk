/**
 * Verifying that a delivery really came from your CMS.
 *
 * A publish webhook is an unauthenticated POST to a URL that anyone can guess
 * or find in a log, and acting on a forged one means deploying whatever the
 * forger fancies. The CMS therefore signs each delivery:
 *
 *   X-Georitham-Signature: sha256=<hmac of `${timestamp}.${body}` with the secret>
 *   X-Georitham-Timestamp: <unix seconds, inside the signed material>
 *   X-Georitham-Event:     page.published
 *   X-Georitham-Delivery:  <id, for matching against the dashboard's log>
 *
 * The timestamp is signed too, which is what stops a captured delivery being
 * replayed a week later: the signature still checks out, the clock does not.
 *
 * Only WebCrypto is used, so this one implementation covers Cloudflare Workers,
 * Node, Deno and Bun. Two rules, both easy to get wrong:
 *
 * - **Verify the raw body.** Parse it afterwards. `JSON.parse` then
 *   `JSON.stringify` produces different bytes and the signature will never
 *   match again.
 * - **Answer before you work.** A delivery still open after ten seconds is
 *   treated as failed and retried, which would start your build twice.
 */

import { CmsError } from './errors.js';

export const SIGNATURE_HEADER = 'x-georitham-signature';
export const TIMESTAMP_HEADER = 'x-georitham-timestamp';
export const EVENT_HEADER = 'x-georitham-event';
export const DELIVERY_HEADER = 'x-georitham-delivery';

/** How old a delivery may be before it is treated as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export const WEBHOOK_EVENTS = [
  'page.published',
  'page.unpublished',
  'page.deleted',
  'media.deleted',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookPage {
  id: number;
  slug: string;
  locale: string;
  title: string;
  /** `published` or `draft` at the moment the event fired. */
  status: string;
  /** `/slug` — a hint, not a route: your site owns its own URLs. */
  urlPath: string;
}

export interface WebhookEvent {
  /** A string, not the union, so an event type added later still parses. */
  event: WebhookEventName | (string & {});
  site: string;
  page: WebhookPage;
  /** The site's publish generation after this event. */
  contentVersion: number;
  /** Present on publishes, absent on unpublishes and deletions. */
  version: { number: number; publishedAt: string } | null;
  /** From the delivery header, for cross-referencing the dashboard's log. */
  delivery: string | null;
  /** Everything as it arrived, for anything not modelled above. */
  raw: Record<string, unknown>;
}

export class WebhookVerificationError extends CmsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('webhook', message, options);
  }
}

/** A `Headers`, a plain object, or Node's `IncomingHttpHeaders`. */
export type HeaderSource =
  | Headers
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** The raw request body, exactly as it arrived. */
  body: string;
  headers: HeaderSource;
  /** The endpoint's signing secret, from the CMS's Webhooks page. */
  secret: string;
  /** Replay window in seconds. Default 300. `0` disables the check. */
  toleranceSeconds?: number;
  /** Override the clock. For tests. */
  now?: () => number;
}

export function readHeader(headers: HeaderSource, name: string): string | null {
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? null;
  }

  const bag = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(bag ?? {})) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

/**
 * Check a delivery and return it parsed, or throw.
 *
 * Every failure is a `WebhookVerificationError`, and the right answer to all of
 * them is `401` — a status the CMS treats as a refusal rather than something to
 * retry, which is correct for a forgery.
 */
export async function verifyWebhook(options: VerifyOptions): Promise<WebhookEvent> {
  const { body, headers, secret } = options;

  if (!secret) {
    throw new WebhookVerificationError(
      'No signing secret — copy the endpoint secret from the CMS Webhooks page.',
    );
  }

  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);

  if (!signature) throw new WebhookVerificationError(`Missing ${SIGNATURE_HEADER}.`);
  if (!timestamp) throw new WebhookVerificationError(`Missing ${TIMESTAMP_HEADER}.`);

  if (!(await isValidSignature({ body, timestamp, signature, secret }))) {
    throw new WebhookVerificationError('Signature does not match.');
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0) {
    const now = (options.now?.() ?? Date.now()) / 1000;
    const age = Math.abs(now - Number(timestamp));
    if (!Number.isFinite(age)) {
      throw new WebhookVerificationError(
        `${TIMESTAMP_HEADER} is not a number of seconds: “${timestamp}”.`,
      );
    }
    if (age > tolerance) {
      throw new WebhookVerificationError(
        `Timestamp is ${Math.round(age)}s away from now — outside the ${tolerance}s window.`,
      );
    }
  }

  return parseWebhookEvent(body, readHeader(headers, DELIVERY_HEADER));
}

/**
 * The signature check on its own, in constant time.
 *
 * Returns `false` rather than throwing, for callers doing their own triage.
 */
export async function isValidSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  secret: string;
}): Promise<boolean> {
  const { body, timestamp, signature, secret } = input;
  if (!secret || !signature?.startsWith('sha256=')) return false;

  const expected = hexToBytes(signature.slice('sha256='.length));
  if (!expected) return false;

  const key = await importKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, expected, encode(`${timestamp}.${body}`));
}

/**
 * Sign a body the way the CMS does.
 *
 * Not needed to receive webhooks — it is here so a receiver can be tested
 * against a real signature instead of a mocked one.
 */
export async function signWebhook(input: {
  body: string;
  timestamp: string | number;
  secret: string;
}): Promise<string> {
  const key = await importKey(input.secret, 'sign');
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encode(`${input.timestamp}.${input.body}`),
  );
  return `sha256=${bytesToHex(new Uint8Array(digest))}`;
}

/**
 * Parse a delivery body without checking it.
 *
 * Only for a body something else has already verified — a gateway, a queue,
 * the `verifyWebhook` call above.
 */
export function parseWebhookEvent(body: string, delivery: string | null = null): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new WebhookVerificationError(`Delivery body is not JSON: ${String(cause)}`, { cause });
  }

  // `null`, `[]` and `12` are all valid JSON and none of them is a delivery.
  // Left unchecked the first one throws a bare TypeError, which a receiver
  // answers with a 500 — and the CMS treats a 500 as worth retrying.
  if (!isObject(parsed)) {
    throw new WebhookVerificationError(
      `Delivery body is not an object: ${body.slice(0, 100)}`,
    );
  }
  const raw = parsed;

  const page = isObject(raw.page) ? raw.page : {};
  const version = isObject(raw.version) ? raw.version : null;

  return {
    event: String(raw.event ?? ''),
    site: String(raw.site ?? ''),
    page: {
      id: Number(page.id ?? 0),
      slug: String(page.slug ?? ''),
      locale: String(page.locale ?? ''),
      title: String(page.title ?? ''),
      status: String(page.status ?? ''),
      urlPath: String(page.url_path ?? ''),
    },
    contentVersion: Number(raw.content_version ?? 0),
    version: version
      ? { number: Number(version.number ?? 0), publishedAt: String(version.published_at ?? '') }
      : null,
    delivery,
    raw,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- WebCrypto odds and ends ------------------------------------------------

const encoder = new TextEncoder();

function encode(value: string): Uint8Array {
  return encoder.encode(value);
}

// The return type is inferred rather than written: `CryptoKey` is a global
// value everywhere this runs, but not a global *type* under Node's typings.
function importKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
