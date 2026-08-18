import assert from 'node:assert/strict';
import test from 'node:test';

import { createClient, createMemoryCache, MAX_PAGE_SIZE } from 'georitham-cms-sdk';

import { SECTIONS, startCms, wirePage } from './support/server.mjs';

/** A client and a server, torn down together. */
async function withCms(options, body) {
  const cms = await startCms(options);
  try {
    return await body(
      cms,
      createClient({ origin: cms.origin, site: cms.site, token: options?.token, ...options?.client }),
    );
  } finally {
    await cms.close();
  }
}

test('the manifest arrives camelCased', async () => {
  await withCms({}, async (_server, client) => {
    const manifest = await client.manifest();

    assert.deepEqual(manifest, {
      site: 'georitham',
      contentVersion: 12,
      pageCount: 2,
      locales: ['de', 'en'],
      configuredLocales: ['de', 'en'],
      defaultLocale: 'de',
    });
  });
});

test('section content is passed through untouched', async () => {
  await withCms({}, async (_server, client) => {
    const page = await client.page('landing-page', { locale: 'de' });

    // Not merely equal: the same keys, in the same shape, with the newline in
    // the body intact. These keys belong to the schema, not the transport.
    assert.deepEqual(page.sections, [SECTIONS.hero]);
    assert.equal(page.sections[0].headingAccent, 'spürbar einfacher macht');
    assert.equal(page.sections[0].body.includes('\n'), true);
    assert.deepEqual(Object.keys(page.sections[0]), Object.keys(SECTIONS.hero));
  });
});

test('the envelope is camelCased around it', async () => {
  await withCms({}, async (_server, client) => {
    const page = await client.page('landing-page', { locale: 'de' });

    assert.equal(page.publishedAt, '2026-08-17T10:00:00Z');
    assert.equal(page.updatedAt, '2026-08-17T10:00:00Z');
    assert.deepEqual(page.translations, ['de', 'en']);
    assert.equal('published_at' in page, false);
  });
});

test('the token travels as a bearer, and locale as a query parameter', async () => {
  await withCms({ token: 'gcms_secret' }, async (server, client) => {
    await client.page('landing-page', { locale: 'en' });

    const last = server.requests().at(-1);
    assert.equal(last.headers.authorization, 'Bearer gcms_secret');
    assert.equal(last.query.locale, 'en');
    assert.equal(last.path, '/api/v1/sites/georitham/pages/landing-page/');
  });
});

test('a wrong token is an auth error, not a mystery', async () => {
  await withCms({ token: 'right' }, async (server, _client) => {
    const client = createClient({ origin: server.origin, site: server.site, token: 'wrong' });
    await assert.rejects(client.manifest(), (error) => {
      assert.equal(error.code, 'auth');
      assert.equal(error.status, 401);
      assert.match(error.message, /check the API token/);
      return true;
    });
  });
});

test('a missing page is a not-found error, and tryPage turns it into null', async () => {
  await withCms({}, async (_server, client) => {
    await assert.rejects(client.page('nope'), (error) => {
      assert.equal(error.code, 'not_found');
      assert.match(error.message, /published, in that language/);
      return true;
    });

    assert.equal(await client.tryPage('nope'), null);
    // A page that exists but not in that language is the same 404.
    assert.equal(await client.tryPage('landing-page', { locale: 'fr' }), null);
  });
});

test('a 500 keeps its status, and a body that is not JSON is a content error', async () => {
  await withCms(
    {
      handler(request, response, url) {
        if (url.pathname.endsWith('/manifest/')) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"detail": "boom"}');
          return true;
        }
        if (url.pathname.endsWith('/pages/')) {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><title>ngrok</title>');
          return true;
        }
        return false;
      },
    },
    async (_server, client) => {
      await assert.rejects(client.manifest(), (error) => {
        assert.equal(error.code, 'response');
        assert.equal(error.status, 500);
        assert.match(error.body, /boom/);
        return true;
      });

      await assert.rejects(client.pages(), (error) => {
        assert.equal(error.code, 'content');
        assert.match(error.message, /did not return JSON/);
        return true;
      });
    },
  );
});

test('a CMS that is not listening is unreachable, not a failure', async () => {
  // Port 1 on loopback refuses immediately; nothing is bound there.
  const client = createClient({ origin: 'http://127.0.0.1:1', site: 'georitham' });

  await assert.rejects(client.manifest(), (error) => {
    assert.equal(error.code, 'unreachable');
    assert.match(error.url, /127\.0\.0\.1:1/);
    return true;
  });
});

test('a CMS that never answers times out as unreachable', async () => {
  await withCms(
    {
      handler() {
        return true; // accept the request and say nothing at all
      },
      client: { timeout: 150 },
    },
    async (_server, client) => {
      await assert.rejects(client.manifest(), (error) => {
        assert.equal(error.code, 'unreachable');
        assert.match(error.message, /timed out/);
        return true;
      });
    },
  );
});

test('a second request is conditional, and a 304 answers from the cache', async () => {
  await withCms({}, async (server, client) => {
    const first = await client.manifest();
    const second = await client.manifest();

    assert.deepEqual(second, first);

    const [, repeat] = server.requests();
    assert.ok(repeat.headers['if-none-match'], 'the second request should be conditional');

    // Prove the 304 path is what answered, rather than a second full response.
    const raw = await client.request('manifest/');
    assert.equal(raw.status, 304);
    assert.equal(raw.notModified, true);
    assert.equal(raw.fromCache, true);
    assert.equal(raw.data.content_version, 12);
  });
});

test('a publish moves the ETag, and the client notices', async () => {
  await withCms({}, async (server, client) => {
    assert.equal((await client.manifest()).contentVersion, 12);
    assert.equal(await client.hasChanged(12), false);

    server.publish();

    assert.equal((await client.manifest()).contentVersion, 13);
    assert.equal(await client.hasChanged(12), true);
  });
});

test('the built-in cache is bounded, so a long-running server cannot leak', async () => {
  const pages = Array.from({ length: 4 }, (_, index) =>
    wirePage({ slug: `page-${index}`, locale: 'de' }),
  );

  await withCms({ pages, client: { cache: createMemoryCache(2) } }, async (server, client) => {
    // Three distinct URLs through a cache that holds two.
    await client.page('page-0', { locale: 'de' });
    await client.page('page-1', { locale: 'de' });
    await client.page('page-2', { locale: 'de' });

    server.state.requests.length = 0;

    // The two most recent are still there; the oldest was evicted.
    await client.page('page-2', { locale: 'de' });
    await client.page('page-1', { locale: 'de' });
    await client.page('page-0', { locale: 'de' });

    const conditional = server.requests().map((request) => Boolean(request.headers['if-none-match']));
    assert.deepEqual(conditional, [true, true, false]);
  });
});

test('reading an entry keeps it, so the busiest URLs survive eviction', async () => {
  const pages = Array.from({ length: 3 }, (_, index) =>
    wirePage({ slug: `page-${index}`, locale: 'de' }),
  );

  await withCms({ pages, client: { cache: createMemoryCache(2) } }, async (server, client) => {
    await client.page('page-0', { locale: 'de' });
    await client.page('page-1', { locale: 'de' });
    await client.page('page-0', { locale: 'de' }); // touched — now the newest
    await client.page('page-2', { locale: 'de' }); // evicts page-1, not page-0

    server.state.requests.length = 0;
    await client.page('page-0', { locale: 'de' });
    await client.page('page-1', { locale: 'de' });

    const conditional = server.requests().map((request) => Boolean(request.headers['if-none-match']));
    assert.deepEqual(conditional, [true, false]);
  });
});

test('caching can be switched off', async () => {
  await withCms({ client: { cache: false } }, async (server, client) => {
    await client.manifest();
    await client.manifest();

    const conditional = server.requests().filter((r) => r.headers['if-none-match']);
    assert.equal(conditional.length, 0);
  });
});

test('allPages follows pagination to the end', async () => {
  const pages = Array.from({ length: 230 }, (_, index) =>
    wirePage({ slug: `page-${String(index).padStart(3, '0')}`, locale: 'de' }),
  );

  await withCms({ pages }, async (server, client) => {
    const seen = [];
    for await (const summary of client.allPages({ locale: 'de' })) seen.push(summary.slug);

    assert.equal(seen.length, 230);
    assert.equal(seen[0], 'page-000');
    assert.equal(seen.at(-1), 'page-229');

    const sizes = server
      .requests()
      .filter((request) => request.path.endsWith('/pages/'))
      .map((request) => Number(request.query.page_size));
    assert.deepEqual(sizes, [MAX_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGE_SIZE]);
  });
});

test('request() reaches anything, and hands back the wire format', async () => {
  await withCms({}, async (_server, client) => {
    const response = await client.request('manifest/');

    assert.equal(response.status, 200);
    assert.equal(response.contentVersion, 12);
    assert.ok(response.etag);
    // Untranslated, so a caller who wants the API's own naming can have it.
    assert.equal(response.data.content_version, 12);
    assert.equal(response.data.default_locale, 'de');
  });
});

test('url() resolves site-relative and absolute paths, and drops empty query values', async () => {
  const client = createClient({ origin: 'https://cms.example.com/', site: 'georitham' });

  assert.equal(
    client.url('pages/', { locale: 'de', page: undefined, page_size: '' }),
    'https://cms.example.com/api/v1/sites/georitham/pages/?locale=de',
  );
  assert.equal(
    client.url('/api/v1/sites/other/manifest/'),
    'https://cms.example.com/api/v1/sites/other/manifest/',
  );
});

test('a caller who aborts gets their own abort back', async () => {
  await withCms(
    {
      handler() {
        return true; // hang
      },
    },
    async (_server, client) => {
      const controller = new AbortController();
      const pending = client.manifest({ signal: controller.signal });
      controller.abort();

      await assert.rejects(pending, (error) => {
        assert.notEqual(error.code, 'unreachable');
        assert.equal(error.name, 'AbortError');
        return true;
      });
    },
  );
});

test('a connection that dies mid-body is unreachable, not bad content', async () => {
  // The difference decides whether a build shrugs and keeps its snapshot or
  // fails the deploy — so a half-delivered answer must not read as a bad one.
  await withCms(
    {
      handler(_request, response) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"site": "georitham", "content_ver');
        response.socket.destroy();
        return true;
      },
    },
    async (_server, client) => {
      await assert.rejects(client.manifest(), (error) => {
        assert.equal(error.code, 'unreachable');
        return true;
      });
    },
  );
});

test('a 200 with no ETag drops the entry rather than revalidating against a dead one', async () => {
  await withCms(
    {
      handler(request, response, url, state) {
        if (!url.pathname.endsWith('/manifest/')) return false;

        const body = JSON.stringify({
          site: 'georitham',
          content_version: state.contentVersion,
          page_count: 0,
          locales: [],
          configured_locales: [],
          default_locale: 'de',
        });

        // First answer carries an ETag, the second does not — a proxy that
        // strips them, or an endpoint that stops setting one.
        const headers = { 'content-type': 'application/json' };
        if (state.requests.filter((entry) => entry.path.endsWith('/manifest/')).length === 1) {
          headers.etag = 'W/"1-12-manifest"';
        }
        response.writeHead(200, headers);
        response.end(body);
        return true;
      },
    },
    async (server, client) => {
      await client.manifest();
      await client.manifest();
      await client.manifest();

      const conditional = server
        .requests()
        .map((entry) => entry.headers['if-none-match']);

      // Sent once, on the request after the ETag arrived — and never again
      // once the answer came back without one.
      assert.deepEqual(conditional, [undefined, 'W/"1-12-manifest"', undefined]);
    },
  );
});

test('allPages survives a count that does not match what arrives', async () => {
  const pages = [wirePage({ slug: 'a' }), wirePage({ slug: 'b' })];

  await withCms(
    {
      pages,
      handler(request, response, url, state) {
        if (!url.pathname.endsWith('/pages/')) return false;

        // Claims far more than it will ever hand over — a page unpublished
        // between the count and the query, or a stale cached count.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            count: 500,
            results:
              url.searchParams.get('page') === '1' ?
                pages.map(({ slug, locale, title, updated_at, version }) => ({
                  slug,
                  locale,
                  title,
                  updated_at,
                  version,
                }))
              : [],
          }),
        );
        return true;
      },
    },
    async (_server, client) => {
      const collected = [];
      for await (const summary of client.allPages()) collected.push(summary.slug);

      assert.deepEqual(collected, ['a', 'b']);
    },
  );
});

test('allPages stops at the 404 that means "past the last page"', async () => {
  // Django's paginator raises past the end; only the first page's 404 is real.
  await withCms(
    {
      handler(request, response, url) {
        if (!url.pathname.endsWith('/pages/')) return false;

        if (url.searchParams.get('page') === '1') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              count: 3,
              results: [
                { slug: 'a', locale: 'de', title: 'A', updated_at: '', version: 1 },
              ],
            }),
          );
        } else {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ detail: 'Invalid page.' }));
        }
        return true;
      },
    },
    async (_server, client) => {
      const collected = [];
      for await (const summary of client.allPages()) collected.push(summary.slug);

      assert.deepEqual(collected, ['a']);
    },
  );
});

test('a page arriving twice across pages is yielded once', async () => {
  // Tied timestamps have no guaranteed order, so a row can surface twice.
  const row = { slug: 'a', locale: 'de', title: 'A', updated_at: '', version: 1 };

  await withCms(
    {
      handler(request, response, url) {
        if (!url.pathname.endsWith('/pages/')) return false;

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            count: 4,
            results:
              url.searchParams.get('page') === '1' ?
                [row, { ...row, slug: 'b' }]
              : [row, { ...row, slug: 'c' }],
          }),
        );
        return true;
      },
    },
    async (_server, client) => {
      const collected = [];
      for await (const summary of client.allPages()) collected.push(summary.slug);

      assert.deepEqual(collected, ['a', 'b', 'c']);
    },
  );
});

test('an origin that is not a URL is refused where it is set, not on first use', async () => {
  assert.throws(() => createClient({ site: 'georitham', origin: 'cms.georitham.ch' }), {
    code: 'config',
  });
  assert.throws(() => createClient({ site: 'georitham', origin: 'ftp://cms.georitham.ch' }), {
    code: 'config',
  });
});

test('a 404 on the manifest is a setup problem, and says so', async () => {
  // The API answers 404 for a site it does not know and for a token belonging
  // to another site. Neither is "is the page published?".
  await withCms(
    {
      handler(_request, response) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Not found.' }));
        return true;
      },
    },
    async (_server, client) => {
      await assert.rejects(client.manifest(), (error) => {
        assert.equal(error.code, 'config');
        assert.match(error.message, /No site “georitham”/);
        return true;
      });
    },
  );
});

test('no token at all is refused as an auth problem, like a bad one', async () => {
  // The CMS says 403 for a missing token and 401 for a wrong one; both are the
  // same thing to fix.
  await withCms({ token: 'gcms_secret', client: { token: undefined } }, async (_server, client) => {
    await assert.rejects(client.manifest(), (error) => {
      assert.equal(error.code, 'auth');
      assert.equal(error.status, 403);
      return true;
    });
  });
});
