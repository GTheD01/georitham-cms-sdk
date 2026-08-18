/**
 * A stand-in for the CMS, over real HTTP.
 *
 * Stubbing `fetch` would prove the code calls a function. A real server on a
 * real port proves the URLs, the headers, the query parameters, the status
 * handling and the conditional requests — which is where the bugs are.
 *
 * It mimics the parts of the API the SDK relies on, and mimics them the way the
 * Django CMS actually behaves rather than the way it would be convenient to:
 * weak ETags tied to the publish generation, `X-Content-Version`, `403` with no
 * token and `401` with a bad one, `404` past the last page of results, `405` on
 * anything that is not a GET. A friendlier fake hides exactly the bugs that a
 * real deployment then finds.
 */

import { createServer } from 'node:http';

export const SECTIONS = {
  hero: {
    type: 'hero',
    eyebrow: '',
    headingLead: 'Technologie, die',
    headingAccent: 'spürbar einfacher macht',
    body: 'Zwei Zeilen Text.\nMit einem Umbruch.',
    trust: ['Swiss hosting', 'Kein Lock-in'],
    ctaPrimary: { label: 'Erstgespräch', href: '#contact' },
    ctaSecondary: { label: '', href: '' },
  },
  faq: {
    type: 'faq',
    heading: 'Fragen',
    intro: '',
    items: [{ question: 'Wie schnell?', answer: 'Zwei Wochen.' }],
  },
};

/** A page as the API serves it — snake_case, exactly like the wire. */
export function wirePage({
  slug = 'landing-page',
  locale = 'de',
  title = 'Startseite',
  sections = [SECTIONS.hero],
  translations = ['de', 'en'],
  version = 3,
} = {}) {
  return {
    slug,
    locale,
    title,
    updated_at: '2026-08-17T10:00:00Z',
    version,
    sections,
    meta: { description: 'Eine Seite.' },
    published_at: '2026-08-17T10:00:00Z',
    translations,
  };
}

/**
 * Start a fake CMS.
 *
 * `pages` is a list of wire pages. Any `handler` given takes precedence, for
 * the tests that need a 500, a hang, or something that is not JSON.
 */
export async function startCms(options = {}) {
  const site = options.site ?? 'georitham';
  const token = options.token ?? null;
  const pages = options.pages ?? [wirePage(), wirePage({ locale: 'en', title: 'Home' })];
  const pageSizeCap = 100;

  const state = {
    contentVersion: options.contentVersion ?? 12,
    requests: [],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...request.headers },
    });

    if (options.handler?.(request, response, url, state)) return;

    if (request.method !== 'GET') {
      return send(response, 405, { detail: 'Method not allowed.' }, state, url);
    }

    // The real API tells the two apart: no token at all on a private site is a
    // 403 about the site, a token it does not accept is a 401 about the token.
    if (token) {
      const authorization = request.headers.authorization;
      if (!authorization) {
        return send(
          response,
          403,
          { detail: 'This site requires an API token.' },
          state,
          url,
        );
      }
      if (authorization !== `Bearer ${token}`) {
        return send(response, 401, { detail: 'Invalid or revoked token.' }, state, url);
      }
    }

    const prefix = `/api/v1/sites/${site}`;

    if (url.pathname === `${prefix}/manifest/`) {
      return send(
        response,
        200,
        {
          site,
          content_version: state.contentVersion,
          page_count: pages.length,
          locales: [...new Set(pages.map((page) => page.locale))].sort(),
          configured_locales: options.configuredLocales ?? ['de', 'en'],
          default_locale: options.defaultLocale ?? 'de',
        },
        state,
        url,
        request,
      );
    }

    if (url.pathname === `${prefix}/pages/`) {
      const locale = url.searchParams.get('locale');
      const number = Number(url.searchParams.get('page') ?? 1);
      const size = Math.min(Number(url.searchParams.get('page_size') ?? 25), pageSizeCap);

      const matching = pages.filter((page) => !locale || page.locale === locale);
      const slice = matching.slice((number - 1) * size, number * size);

      // Django's paginator raises past the end, and DRF turns that into a 404.
      if (slice.length === 0 && number > 1) {
        return send(response, 404, { detail: 'Invalid page.' }, state, url);
      }

      return send(
        response,
        200,
        {
          count: matching.length,
          results: slice.map(({ slug, locale: pageLocale, title, updated_at, version }) => ({
            slug,
            locale: pageLocale,
            title,
            updated_at,
            version,
          })),
        },
        state,
        url,
        request,
      );
    }

    const detail = url.pathname.match(new RegExp(`^${prefix}/pages/([^/]+)/$`));
    if (detail) {
      const slug = decodeURIComponent(detail[1]);
      const locale = url.searchParams.get('locale') ?? (options.defaultLocale ?? 'de');
      const page = pages.find((item) => item.slug === slug && item.locale === locale);

      if (!page) {
        return send(response, 404, { detail: 'No published page with that slug.' }, state, url);
      }
      return send(response, 200, page, state, url, request);
    }

    send(response, 404, { detail: 'Not found.' }, state, url);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    site,
    state,
    /** Simulate a publish: the generation moves, so every ETag changes. */
    publish() {
      state.contentVersion += 1;
    },
    requests: () => state.requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function send(response, status, payload, state, url, request) {
  const body = JSON.stringify(payload);
  // Weak, like the real one: `W/"<site>-<generation>-<parts>"`. The SDK has to
  // echo it back byte for byte, since the CMS compares the strings exactly.
  const etag = `W/"1-${state.contentVersion}-${url.pathname}${url.search}"`;

  if (status === 200 && request?.headers['if-none-match'] === etag) {
    response.writeHead(304, {
      etag,
      'x-content-version': String(state.contentVersion),
    });
    return response.end();
  }

  response.writeHead(status, {
    'content-type': 'application/json',
    ...(status === 200 ? { etag } : {}),
    'x-content-version': String(state.contentVersion),
  });
  response.end(body);
}
