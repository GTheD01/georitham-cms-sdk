/**
 * The read client.
 *
 * One object covers every way a site consumes the CMS: a build script pulling a
 * snapshot, a Next.js route rendering per request, a Worker at the edge, a cron
 * job checking whether anything changed. Nothing here is Node-specific — it is
 * `fetch` and `AbortSignal` and nothing else — so the same import works in a
 * Worker as in a build.
 *
 * Two things are worth knowing before reading further.
 *
 * **ETags are used by default.** Every response carries one derived from the
 * site's publish generation, so a conditional request costs a 304 with no body
 * for as long as nobody publishes. The cache is a plain `Map` unless you hand
 * over your own store.
 *
 * **`request()` is not private.** The typed methods are conveniences over it;
 * when the API grows something this SDK has not learned yet, `request()` still
 * reaches it, with the same auth, timeouts, errors and caching.
 */

import {
  CmsAuthError,
  CmsConfigError,
  CmsContentError,
  CmsNotFoundError,
  CmsResponseError,
  CmsUnreachableError,
} from './errors.js';
import type {
  CacheEntry,
  CacheStore,
  CmsResponse,
  Manifest,
  PageDetail,
  PageList,
  PageSummary,
} from './types.js';
import type { AnySection } from './sections.js';
import { watchContent } from './poll.js';
import type { StopWatching, WatchOptions } from './poll.js';

/** The API's own ceiling; asking for more is silently capped server-side. */
export const MAX_PAGE_SIZE = 100;

/**
 * Georitham CMS. There is one, and this is where it is.
 *
 * Set `origin` only to point somewhere else — a self-hosted instance, a staging
 * copy, or a CMS running on your own machine while you work on the CMS itself.
 */
export const DEFAULT_ORIGIN = 'https://cms.georitham.ch';

const DEFAULT_TIMEOUT = 10_000;

export interface ClientOptions {
  /**
   * Your website's slug — the one in the dashboard's address bar, and the
   * `{site}` in every API path. The one thing a client has to supply.
   */
  site: string;
  /** Defaults to `DEFAULT_ORIGIN`. */
  origin?: string;
  /** Omit only for a site with public reads switched on. */
  token?: string;
  /**
   * Swap in your own `fetch`: a test double, a Worker's bound fetcher, a
   * retrying wrapper, or Next.js's caching one with `{next: {revalidate}}`
   * baked in.
   */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. `0` disables it. Default 10 000. */
  timeout?: number;
  /**
   * ETag caching: on (default), off, or your own store. The built-in one keeps
   * the last `DEFAULT_CACHE_SIZE` responses and evicts the least recently used.
   */
  cache?: boolean | CacheStore;
  /** Extra headers on every request — a corporate proxy, a tunnel's bypass. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  /** Query parameters. `undefined` and `''` are dropped rather than sent. */
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /**
   * Make the request conditional by hand. Pass an ETag to send
   * `If-None-Match`, or `false` to bypass the cache entirely.
   */
  etag?: string | false;
  signal?: AbortSignal;
  timeout?: number;
}

export interface PageQuery {
  /** Defaults to the site's own default locale, server-side. */
  locale?: string;
  signal?: AbortSignal;
}

export interface PageListQuery extends PageQuery {
  /** 1-based. */
  page?: number;
  /** Up to `MAX_PAGE_SIZE`. Default 25, server-side. */
  pageSize?: number;
}

/** How many responses the built-in cache keeps before evicting. */
export const DEFAULT_CACHE_SIZE = 200;

/**
 * In-memory, per-client, and gone when the process is.
 *
 * Bounded, because the alternative is a slow leak: a server rendering pages on
 * demand caches one entry per slug and locale it is ever asked for, and each
 * entry holds a whole page. Least-recently-used goes first — `Map` iterates in
 * insertion order, so re-inserting on read is all the bookkeeping needed.
 *
 * Hand `cache` your own store to keep them somewhere with a real eviction
 * policy: KV, Redis, the filesystem.
 */
class MemoryCache implements CacheStore {
  #entries = new Map<string, CacheEntry>();
  readonly #limit: number;

  constructor(limit = DEFAULT_CACHE_SIZE) {
    this.#limit = Math.max(1, limit);
  }

  get(key: string) {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      // Touch it, so the busiest URLs are the last to be evicted.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string) {
    this.#entries.delete(key);
  }
}

export class CmsClient {
  readonly origin: string;
  readonly site: string;

  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #cache: CacheStore | null;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions) {
    if (!options?.site) {
      throw new CmsConfigError(
        'createClient needs a `site` — your website’s slug, from the dashboard.',
      );
    }

    this.origin = normaliseOrigin(options.origin || DEFAULT_ORIGIN);
    this.site = options.site;
    this.#token = options.token || undefined;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.#headers = options.headers ?? {};

    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation" in
    // browsers, and this is exactly the kind of bug that only shows up there.
    const provided = options.fetch ?? globalThis.fetch;
    if (typeof provided !== 'function') {
      throw new CmsConfigError(
        'No global fetch — pass one as `fetch`, or run on Node 18 or newer.',
      );
    }
    this.#fetch = provided.bind(globalThis);

    const cache = options.cache ?? true;
    this.#cache = cache === false ? null : cache === true ? new MemoryCache() : cache;
  }

  /** The full URL for a path under this site, query included. */
  url(path: string, query?: RequestOptions['query']): string {
    const base = path.startsWith('/') ? path : `/api/v1/sites/${this.site}/${path}`;
    const url = new URL(`${this.origin}${base}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One GET, with auth, timeout, ETag handling and error triage.
   *
   * `path` is either a full API path (leading `/`) or one relative to this
   * site, so `request('manifest/')` and
   * `request('/api/v1/sites/other/manifest/')` both work.
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<CmsResponse<T>> {
    const url = this.url(path, options.query);
    const useCache = this.#cache !== null && options.etag === undefined;
    const cached = useCache ? await this.#cache!.get(url) : undefined;

    const conditional =
      typeof options.etag === 'string' ? options.etag : (cached?.etag ?? null);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.#headers,
      ...options.headers,
    };
    if (this.#token) headers['Authorization'] = `Bearer ${this.#token}`;
    if (conditional) headers['If-None-Match'] = conditional;

    const response = await this.#send(url, headers, options);

    const etag = response.headers.get('etag');
    const contentVersion = numberOrNull(response.headers.get('x-content-version'));

    if (response.status === 304) {
      // Nothing has been published since we last looked. If we are the ones
      // holding the ETag, we are also the ones holding the body.
      return {
        data: (cached?.data as T) ?? null,
        status: 304,
        etag: etag ?? conditional,
        contentVersion: contentVersion ?? cached?.contentVersion ?? null,
        notModified: true,
        fromCache: cached !== undefined,
        response,
      };
    }

    if (response.status === 401 || response.status === 403) {
      // A plain-http origin against a CMS that redirects to https loses the
      // Authorization header on the way — the request arrives unauthenticated
      // and the answer looks like a bad token rather than a bad origin.
      const hint =
        response.redirected && this.origin.startsWith('http://') ?
          ` The request was redirected, which drops the Authorization header — use ${this.origin.replace(/^http:/, 'https:')} as the origin.`
        : '';
      throw new CmsAuthError(response.status, url, await bodyText(response), hint);
    }
    if (response.status === 404) {
      throw new CmsNotFoundError(url, await bodyText(response));
    }
    if (!response.ok) {
      throw new CmsResponseError(response.status, url, await bodyText(response));
    }

    // Reading the body and understanding it are two different failures. A
    // socket that dies halfway through is the CMS being unreachable — the same
    // thing `#send` reports — and a build must shrug at it rather than treat a
    // half-delivered response as bad content and fail the deploy.
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new CmsUnreachableError(url, `${url}: ${messageOf(cause)}`, { cause });
    }

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (cause) {
      throw new CmsContentError(
        `${url} did not return JSON — is that really the CMS? It sent: ${clamp(text)}`,
        { cause },
      );
    }

    if (useCache) {
      // No ETag means nothing to revalidate against. Dropping the old entry is
      // the point: keeping it would send a dead `If-None-Match` forever.
      if (etag) await this.#cache!.set(url, { etag, data, contentVersion });
      else await this.#cache!.delete(url);
    }

    return {
      data,
      status: response.status,
      etag,
      contentVersion,
      notModified: false,
      fromCache: false,
      response,
    };
  }

  async #send(
    url: string,
    headers: Record<string, string>,
    options: RequestOptions,
  ): Promise<Response> {
    const timeout = options.timeout ?? this.#timeout;
    const signal = combineSignals(options.signal, timeout);

    try {
      return await this.#fetch(url, { headers, signal });
    } catch (cause) {
      // A caller who aborted deliberately wants their own abort back, not a
      // report that the CMS is down.
      if (options.signal?.aborted) throw cause;
      throw new CmsUnreachableError(url, `${url}: ${messageOf(cause)}`, { cause });
    }
  }

  /** Site-wide state, in one cheap call. */
  async manifest(options: { signal?: AbortSignal } = {}): Promise<Manifest> {
    let data: WireManifest | null;
    try {
      ({ data } = await this.request<WireManifest>('manifest/', {
        signal: options.signal,
      }));
    } catch (error) {
      // Every site has a manifest, so a 404 here is never "not published yet".
      // The API answers 404 for a site it does not know *and* for a token that
      // belongs to a different site — which are both setup, not content.
      if ((error as { code?: string })?.code === 'not_found') {
        throw new CmsConfigError(
          `No site “${this.site}” at ${this.origin} — check the slug from the dashboard’s address bar, and that the token belongs to this site.`,
          { cause: error },
        );
      }
      throw error;
    }
    return toManifest(require_(data, 'manifest'));
  }

  /** One page of the page list. */
  async pages(options: PageListQuery = {}): Promise<PageList> {
    const { data } = await this.request<WirePageList>('pages/', {
      query: {
        locale: options.locale,
        page: options.page,
        page_size: options.pageSize,
      },
      signal: options.signal,
    });

    const wire = require_(data, 'page list');
    if (!Array.isArray(wire.results)) {
      throw new CmsContentError('The page list had no `results` array.');
    }
    return {
      count: Number(wire.count ?? wire.results.length),
      results: wire.results.map(toPageSummary),
    };
  }

  /**
   * Every published page, following pagination to the end.
   *
   * Without a `locale` this yields each language separately, which is what the
   * API stores: a page in German and a page in English are two pages that share
   * a slug.
   */
  async *allPages(options: PageQuery = {}): AsyncGenerator<PageSummary> {
    let page = 1;
    let seen = 0;
    let ceiling = Number.POSITIVE_INFINITY;

    // A page and its translation share a slug, so identity is the pair. The API
    // sorts by a timestamp that pages published together share, and a tie has
    // no guaranteed order — so the same row can surface on two pages.
    const yielded = new Set<string>();

    for (;;) {
      let batch: PageList;
      try {
        batch = await this.pages({ ...options, page, pageSize: MAX_PAGE_SIZE });
      } catch (error) {
        // Asking past the last page is a 404. On the first page that means the
        // site is missing; after it, it only means we have reached the end.
        if (page > 1 && (error as { code?: string })?.code === 'not_found') return;
        throw error;
      }

      for (const summary of batch.results) {
        const identity = `${summary.slug}\0${summary.locale}`;
        if (yielded.has(identity)) continue;
        yielded.add(identity);
        yield summary;
      }

      seen += batch.results.length;
      if (batch.results.length === 0 || seen >= batch.count) return;

      // A server that ignores `page` would answer the first one forever.
      if (ceiling === Number.POSITIVE_INFINITY) {
        ceiling = Math.ceil(batch.count / MAX_PAGE_SIZE) + 2;
      }
      if (page >= ceiling) {
        throw new CmsContentError(
          `The page list did not end after ${ceiling} requests (it claims ${batch.count} pages) — is something in front of the CMS ignoring \`page\`?`,
        );
      }
      page += 1;
    }
  }

  /** One published page, with its sections. Throws if it is not published. */
  async page(slug: string, options: PageQuery = {}): Promise<PageDetail> {
    const { data } = await this.request<WirePageDetail>(`pages/${encodeURIComponent(slug)}/`, {
      query: { locale: options.locale },
      signal: options.signal,
    });
    return toPageDetail(require_(data, `page “${slug}”`));
  }

  /** The same, but `null` where `page()` would throw a 404. */
  async tryPage(slug: string, options: PageQuery = {}): Promise<PageDetail | null> {
    try {
      return await this.page(slug, options);
    } catch (error) {
      if ((error as { code?: string })?.code === 'not_found') return null;
      throw error;
    }
  }

  /** Has anything been published since that version? One manifest call. */
  async hasChanged(since: number, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const manifest = await this.manifest(options);
    return manifest.contentVersion !== since;
  }

  /**
   * Poll for publishes, calling back when the content version moves.
   * Returns a function that stops it. See `watchContent` for the details.
   */
  watch(
    options: WatchOptions,
    onChange: (manifest: Manifest) => void | Promise<void>,
  ): StopWatching {
    return watchContent(this, options, onChange);
  }
}

export function createClient(options: ClientOptions): CmsClient {
  return new CmsClient(options);
}

/**
 * The built-in ETag cache, sized to taste.
 *
 *   createClient({ site, cache: createMemoryCache(2000) })
 *
 * Worth raising for a server that renders many pages on demand, and lowering
 * for somewhere memory is tight. Anything implementing `CacheStore` works just
 * as well, which is the way to reach for KV or Redis.
 */
export function createMemoryCache(limit = DEFAULT_CACHE_SIZE): CacheStore {
  return new MemoryCache(limit);
}

// --- the wire ---------------------------------------------------------------

interface WireManifest {
  site: string;
  content_version: number;
  page_count: number;
  locales: string[];
  configured_locales: string[];
  default_locale: string;
}

interface WirePageSummary {
  slug: string;
  locale: string;
  title: string;
  updated_at: string;
  version: number;
}

interface WirePageDetail extends WirePageSummary {
  sections: AnySection[];
  meta: Record<string, unknown>;
  published_at: string;
  translations: string[];
}

interface WirePageList {
  count: number;
  results: WirePageSummary[];
}

function require_<T>(data: T | null, what: string): T {
  if (data === null || typeof data !== 'object') {
    throw new CmsContentError(`Empty or unreadable ${what} response.`);
  }
  return data;
}

function toManifest(wire: WireManifest): Manifest {
  return {
    site: String(wire.site ?? ''),
    contentVersion: Number(wire.content_version ?? 0),
    pageCount: Number(wire.page_count ?? 0),
    locales: [...(wire.locales ?? [])],
    configuredLocales: [...(wire.configured_locales ?? [])],
    defaultLocale: String(wire.default_locale ?? ''),
  };
}

function toPageSummary(wire: WirePageSummary): PageSummary {
  return {
    slug: String(wire.slug ?? ''),
    locale: String(wire.locale ?? ''),
    title: String(wire.title ?? ''),
    updatedAt: String(wire.updated_at ?? ''),
    version: Number(wire.version ?? 0),
  };
}

function toPageDetail(wire: WirePageDetail): PageDetail {
  if (!Array.isArray(wire.sections)) {
    throw new CmsContentError(
      `The page “${wire.slug}” came back without a \`sections\` array.`,
    );
  }
  return {
    ...toPageSummary(wire),
    // Untouched, deliberately: these keys are the content's, not the wire's.
    sections: wire.sections,
    meta: wire.meta ?? {},
    publishedAt: String(wire.published_at ?? ''),
    translations: [...(wire.translations ?? [])],
  };
}

// --- odds and ends ----------------------------------------------------------

function numberOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Enough of a body to recognise it, never enough to fill a terminal. */
function clamp(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

async function bodyText(response: Response): Promise<string> {
  try {
    return clamp(await response.text());
  } catch {
    return '';
  }
}

/**
 * An origin the SDK can actually build URLs from.
 *
 * Left unchecked, a typo here surfaces as a bare `TypeError` from `new URL` on
 * the first request, a long way from the setting that caused it.
 */
function normaliseOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CmsConfigError(
      `“${origin}” is not a URL — an origin looks like ${DEFAULT_ORIGIN}.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CmsConfigError(
      `The origin “${origin}” is not http or https — an origin looks like ${DEFAULT_ORIGIN}.`,
    );
  }
  return origin.replace(/\/+$/, '');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // A timeout arrives as a bare TimeoutError, which on its own reads like a
    // bug rather than a CMS that did not answer.
    return error.name === 'TimeoutError' ? 'timed out' : error.message;
  }
  return String(error);
}

function combineSignals(signal: AbortSignal | undefined, timeout: number): AbortSignal | undefined {
  const deadline = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  if (!signal) return deadline;
  if (!deadline) return signal;
  // Node 20.3+, and every runtime this ships to. Falling back to the caller's
  // signal alone is better than refusing to run.
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : signal;
}
