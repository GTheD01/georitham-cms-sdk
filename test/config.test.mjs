/**
 * Where the settings come from, and which one wins.
 *
 * The case worth pinning is the one CI produces by accident: a variable set
 * from a secret that is not there yet arrives as an empty string, not as an
 * absent one. Treating that as an answer is how a perfectly good config file
 * gets shadowed by nothing at all.
 *
 * `config.ts` is the CLI's, not the package's — hence the path import.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../dist/config.js';

const VARIABLES = ['CMS_SITE', 'CMS_TOKEN', 'CMS_OUT', 'CMS_ORIGIN', 'CMS_PAGES', 'CMS_LOCALES'];

/** A project directory with a config file, and a clean environment around it. */
async function project(config, environment = {}) {
  const root = await mkdtemp(join(tmpdir(), 'georitham-config-'));
  if (config) {
    await writeFile(join(root, 'georitham.config.json'), JSON.stringify(config), 'utf8');
  }

  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, environment);

  return {
    root,
    restore() {
      for (const name of VARIABLES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    },
  };
}

test('an empty CMS_SITE does not shadow the site in the config file', async () => {
  const { root, restore } = await project({ site: 'acme-site' }, { CMS_SITE: '' });

  try {
    assert.equal(loadConfig({ root }).site, 'acme-site');
  } finally {
    restore();
  }
});

test('an empty CMS_OUT does not point the snapshot at the project root', async () => {
  const { root, restore } = await project({ site: 'acme-site' }, { CMS_OUT: '  ' });

  try {
    const config = loadConfig({ root });

    assert.equal(config.out, 'src/data/content.json');
    assert.equal(config.outPath, resolve(root, 'src/data/content.json'));
  } finally {
    restore();
  }
});

test('an empty CMS_TOKEN is no token, not an empty one', async () => {
  const { root, restore } = await project({ site: 'acme-site' }, { CMS_TOKEN: '' });

  try {
    assert.equal(loadConfig({ root }).token, undefined);
  } finally {
    restore();
  }
});

test('a variable that says something still beats the config file', async () => {
  const { root, restore } = await project(
    { site: 'acme-site', out: 'from/file.json' },
    { CMS_SITE: 'other-site', CMS_OUT: 'from/env.json' },
  );

  try {
    const config = loadConfig({ root });

    assert.equal(config.site, 'other-site');
    assert.equal(config.out, 'from/env.json');
  } finally {
    restore();
  }
});

test('no site anywhere is still the error it was', async () => {
  const { root, restore } = await project(null, {});

  try {
    assert.throws(() => loadConfig({ root }), { code: 'config' });
  } finally {
    restore();
  }
});

test('an empty list in the config file is refused where it is written', async () => {
  const { root, restore } = await project({ site: 'acme-site', pages: [] }, {});

  try {
    assert.throws(() => loadConfig({ root }), (error) => {
      assert.equal(error.code, 'config');
      assert.match(error.message, /georitham\.config\.json/);
      return true;
    });
  } finally {
    restore();
  }
});

test('the origin falls back to the hosted CMS, and loses its trailing slash', async () => {
  const { root, restore } = await project({ site: 'acme-site' }, { CMS_ORIGIN: '' });

  try {
    assert.equal(loadConfig({ root }).origin, 'https://cms.georitham.ch');
  } finally {
    restore();
  }

  const second = await project({ site: 'acme-site' }, { CMS_ORIGIN: 'http://localhost:8000/' });
  try {
    assert.equal(loadConfig({ root: second.root }).origin, 'http://localhost:8000');
  } finally {
    second.restore();
  }
});
