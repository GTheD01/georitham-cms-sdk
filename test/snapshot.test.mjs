import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from 'georitham-cms-sdk';
import { readSnapshot, snapshotPage, writeSnapshot } from 'georitham-cms-sdk/snapshot';

import { SECTIONS, startCms, wirePage } from './support/server.mjs';

async function workspace() {
  return mkdtemp(join(tmpdir(), 'georitham-snapshot-'));
}

async function withCms(options, body) {
  const cms = await startCms(options);
  try {
    return await body(cms, createClient({ origin: cms.origin, site: cms.site }));
  } finally {
    await cms.close();
  }
}

test('a snapshot holds whole pages, keyed by slug and language', async () => {
  const dir = await workspace();
  const out = join(dir, 'src/data/content.json');

  await withCms({}, async (_server, client) => {
    const result = await writeSnapshot({ client, out, cwd: dir });

    assert.equal(result.status, 'ok');
    assert.equal(result.changed, true);
    assert.equal(result.pageCount, 2);

    const snapshot = await readSnapshot(out);
    assert.deepEqual(Object.keys(snapshot.pages), ['landing-page']);
    assert.deepEqual(Object.keys(snapshot.pages['landing-page']), ['de', 'en']);
    assert.equal(snapshot.meta.site, 'georitham');
    assert.equal(snapshot.meta.contentVersion, 12);

    // Whole pages, so a second section type needs no change to the tooling.
    const page = snapshotPage(snapshot, 'landing-page', 'de');
    assert.deepEqual(page.sections, [SECTIONS.hero]);
    assert.deepEqual(page.translations, ['de', 'en']);
  });
});

test('the directory is created, and the file ends with a newline', async () => {
  const dir = await workspace();
  const out = join(dir, 'deeply/nested/content.json');

  await withCms({}, async (_server, client) => {
    await writeSnapshot({ client, out, cwd: dir });
    assert.match(await readFile(out, 'utf8'), /\n$/);
  });
});

test('an unchanged pull leaves the file alone, so git stays quiet', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms({}, async (_server, client) => {
    await writeSnapshot({ client, out, cwd: dir });
    const first = await stat(out);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await writeSnapshot({ client, out, cwd: dir });

    assert.equal(again.changed, false);
    assert.equal((await stat(out)).mtimeMs, first.mtimeMs, 'the file should not be rewritten');
  });
});

test('an unreachable CMS keeps the snapshot and does not throw', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');
  await writeFile(out, '{"meta":{"site":"georitham"},"pages":{"kept":{"de":{}}}}\n');

  const client = createClient({ origin: 'http://127.0.0.1:1', site: 'georitham' });
  const result = await writeSnapshot({ client, out, cwd: dir });

  assert.equal(result.status, 'unreachable');
  assert.equal(result.error.code, 'unreachable');
  assert.match(await readFile(out, 'utf8'), /kept/);
});

test('a missing required section fails, and the good snapshot survives it', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms({ pages: [wirePage({ sections: [SECTIONS.faq] })] }, async (_server, client) => {
    // A good snapshot first, so there is something to protect.
    await writeSnapshot({ client, out, cwd: dir, require: {} });
    const before = await readFile(out, 'utf8');

    await assert.rejects(
      writeSnapshot({ client, out, cwd: dir, require: { 'landing-page': ['hero'] } }),
      (error) => {
        assert.equal(error.code, 'content');
        assert.match(error.message, /no “hero” section \(it has: faq\)/);
        return true;
      },
    );

    assert.equal(await readFile(out, 'utf8'), before);
  });
});

test('“*” requires a section of every page', async () => {
  const dir = await workspace();

  await withCms({ pages: [wirePage({ sections: [SECTIONS.faq] })] }, async (_server, client) => {
    await assert.rejects(
      writeSnapshot({ client, out: join(dir, 'c.json'), cwd: dir, require: { '*': ['hero'] } }),
      /no “hero” section/,
    );
  });
});

test('a language asked for by name must be there', async () => {
  const dir = await workspace();

  await withCms({ pages: [wirePage({ locale: 'de' })] }, async (_server, client) => {
    await assert.rejects(
      writeSnapshot({
        client,
        out: join(dir, 'c.json'),
        cwd: dir,
        pages: ['landing-page'],
        locales: ['de', 'fr'],
      }),
      (error) => {
        assert.equal(error.code, 'not_found');
        return true;
      },
    );
  });
});

test('a configured language with nothing published yet is simply skipped', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms(
    { pages: [wirePage({ locale: 'de' })], configuredLocales: ['de', 'en', 'fr'] },
    async (_server, client) => {
      const result = await writeSnapshot({
        client,
        out,
        cwd: dir,
        pages: ['landing-page'],
        locales: 'configured',
      });

      assert.equal(result.status, 'ok');
      assert.deepEqual(Object.keys(result.snapshot.pages['landing-page']), ['de']);
    },
  );
});

test('a page published in no requested language at all is an error', async () => {
  const dir = await workspace();

  await withCms({ pages: [wirePage({ locale: 'de' })] }, async (_server, client) => {
    await assert.rejects(
      writeSnapshot({
        client,
        out: join(dir, 'c.json'),
        cwd: dir,
        pages: ['ghost'],
        locales: 'configured',
      }),
      /“ghost” is not published in any of: de, en/,
    );
  });
});

test('pages: "all" discovers what is published, in every language it exists in', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');

  const pages = [
    wirePage({ slug: 'about', locale: 'de' }),
    wirePage({ slug: 'landing-page', locale: 'de' }),
    wirePage({ slug: 'landing-page', locale: 'en' }),
  ];

  await withCms({ pages }, async (_server, client) => {
    const result = await writeSnapshot({ client, out, cwd: dir, pages: 'all' });

    // Sorted, so the committed file does not reshuffle between pulls.
    assert.deepEqual(Object.keys(result.snapshot.pages), ['about', 'landing-page']);
    assert.deepEqual(Object.keys(result.snapshot.pages['landing-page']), ['de', 'en']);
    assert.deepEqual(Object.keys(result.snapshot.pages.about), ['de']);
  });
});

test('reading a snapshot that is missing, or not one, says so plainly', async () => {
  const dir = await workspace();

  await assert.rejects(readSnapshot(join(dir, 'nothing.json')), /run `georitham-cms pull`/);

  await writeFile(join(dir, 'bad.json'), '{oops');
  await assert.rejects(readSnapshot(join(dir, 'bad.json')), /not valid JSON/);

  await writeFile(join(dir, 'other.json'), '{"hello": true}');
  await assert.rejects(readSnapshot(join(dir, 'other.json')), /does not look like a snapshot/);
});

test('asking a snapshot for a page it has not got lists what it has', async () => {
  const snapshot = { meta: {}, pages: { 'landing-page': { de: { slug: 'landing-page' } } } };

  assert.throws(
    () => snapshotPage(snapshot, 'landing-page', 'fr'),
    /has no “landing-page” in “fr”\. It has: landing-page \(de\)/,
  );
});

test('an empty page list refuses to run, and the good snapshot survives it', async () => {
  // The whole point of the module: a bad answer must never overwrite a good
  // snapshot — and "nothing at all" is the worst answer of the lot.
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms({}, async (_server, client) => {
    await writeSnapshot({ client, out, cwd: dir });
    const before = await readFile(out, 'utf8');

    await assert.rejects(writeSnapshot({ client, out, cwd: dir, pages: [] }), (error) => {
      assert.equal(error.code, 'config');
      assert.match(error.message, /empty/);
      return true;
    });

    assert.equal(await readFile(out, 'utf8'), before);
  });
});

test('an empty language list refuses to run too', async () => {
  const dir = await workspace();

  await withCms({}, async (_server, client) => {
    await assert.rejects(
      writeSnapshot({ client, out: join(dir, 'c.json'), cwd: dir, locales: [] }),
      (error) => {
        assert.equal(error.code, 'config');
        return true;
      },
    );
  });
});

test('pages: "all" enforces a language asked for by name, like an explicit list does', async () => {
  // The two paths used to disagree: an explicit page list 404d on a missing
  // translation while discovery quietly dropped it.
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms({ pages: [wirePage({ locale: 'de' })] }, async (_server, client) => {
    await assert.rejects(
      writeSnapshot({ client, out, cwd: dir, pages: 'all', locales: ['de', 'fr'] }),
      (error) => {
        assert.equal(error.code, 'not_found');
        return true;
      },
    );

    // Nothing was written on the way past.
    await assert.rejects(stat(out));
  });
});

test('pages: "all" with configured languages still skips what is not translated', async () => {
  const dir = await workspace();
  const out = join(dir, 'content.json');

  await withCms(
    { pages: [wirePage({ locale: 'de' })], configuredLocales: ['de', 'en', 'fr'] },
    async (_server, client) => {
      const result = await writeSnapshot({ client, out, cwd: dir, pages: 'all' });

      assert.equal(result.status, 'ok');
      assert.deepEqual(Object.keys(result.snapshot.pages['landing-page']), ['de']);
    },
  );
});
