/**
 * What the API returns, once the transport's naming has been tidied.
 *
 * The envelope is camelCased — `content_version` becomes `contentVersion` —
 * because those keys belong to the transport. **Section content is passed
 * through untouched**, because those keys belong to the schema: `headingLead`
 * is what an editor's field is called, and renaming it here would put this SDK
 * between you and your own content.
 *
 * Timestamps stay ISO 8601 strings rather than `Date` objects, so a payload
 * survives a round trip through `JSON.stringify` into a committed snapshot and
 * back out unchanged. `new Date(page.publishedAt)` is one call away when a page
 * actually needs to format one.
 */

import type { AnySection } from './sections.js';

/** The cheap poll. `contentVersion` changes on every publish, site-wide. */
export interface Manifest {
  site: string;
  contentVersion: number;
  pageCount: number;
  /** Languages with something published right now. */
  locales: string[];
  /** Languages the site is set up for — a superset of `locales`. */
  configuredLocales: string[];
  defaultLocale: string;
}

/** A page as it appears in a listing. */
export interface PageSummary {
  slug: string;
  locale: string;
  title: string;
  /** ISO 8601. */
  updatedAt: string;
  /** The published version number, counting up from 1. */
  version: number;
}

/** A page with its content. */
export interface PageDetail extends PageSummary {
  sections: AnySection[];
  meta: Record<string, unknown>;
  /** ISO 8601. */
  publishedAt: string;
  /**
   * Every language this page is live in, this one included — what a language
   * switcher needs to avoid linking into a 404.
   */
  translations: string[];
}

export interface PageList {
  /** Total across all pages of results, not the length of `results`. */
  count: number;
  results: PageSummary[];
}

/**
 * One HTTP exchange, for callers who want the envelope as well as the body.
 *
 * `data` is `null` only when `notModified` is true and nothing was cached to
 * return — a 304 genuinely has no body.
 */
export interface CmsResponse<T> {
  data: T | null;
  status: number;
  etag: string | null;
  /** From `X-Content-Version`: the site's publish generation. */
  contentVersion: number | null;
  notModified: boolean;
  /** Whether `data` came from the ETag cache rather than this response. */
  fromCache: boolean;
  /** The raw response. Its body is already consumed. */
  response: Response;
}

/** What an ETag cache stores. Implement this to swap in KV, Redis, a file. */
export interface CacheEntry {
  etag: string;
  data: unknown;
  contentVersion: number | null;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}
