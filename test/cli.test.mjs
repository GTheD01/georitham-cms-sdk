/**
 * The CLI, run the way a user runs it: as a process, with an exit code.
 *
 * The exit codes are the contract worth pinning down. `npm run content` in a
 * CI pipeline succeeds or fails on them, and the difference between "the CMS
 * was asleep" and "the content is wrong" is exactly the difference between a
 * deploy that carries on and one that stops.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SECTIONS, startCms, wirePage } from './support/server.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

async function georithamCms(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function project(config) {
  const dir = await mkdtemp(join(tmpdir(), 'georitham-cli-'));
  if (config) await writeFile(join(dir, 'georitham.config.json'), JSON.stringify(config));
  return dir;
}

test('--help works, and an unknown command does not', async () => {
  const help = await georithamCms(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /pull {9}fetch the configured pages/);

  const commandHelp = await georithamCms(['pull', '--help']);
  assert.equal(commandHelp.code, 0);
  assert.match(commandHelp.stdout, /Usage: georitham-cms pull/);

  const unknown = await georithamCms(['frobnicate']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command/);
});

test('manifest summarises the site', async () => {
  const cms = await startCms({ configuredLocales: ['de', 'en', 'fr'] });
  try {
    const result = await georithamCms(['manifest'], {
      cwd: await project(),
      env: { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site },
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /content version {4}12/);
    assert.match(result.stdout, /published in {7}de, en/);
    assert.match(result.stdout, /nothing published yet: fr/);
  } finally {
    await cms.close();
  }
});

test('pull writes the snapshot the config asks for, and says so', async () => {
  const cms = await startCms();
  const dir = await project({ out: 'src/data/content.json', pages: ['landing-page'] });

  try {
    const result = await georithamCms(['pull'], {
      cwd: dir,
      env: { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site },
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Snapshot updated from content version 12/);
    assert.match(result.stdout, /Commit src\/data\/content\.json/);

    const snapshot = JSON.parse(await readFile(join(dir, 'src/data/content.json'), 'utf8'));
    assert.deepEqual(snapshot.pages['landing-page'].de.sections, [SECTIONS.hero]);

    // A second pull changes nothing and says that instead.
    const again = await georithamCms(['pull'], {
      cwd: dir,
      env: { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site },
    });
    assert.match(again.stdout, /Snapshot unchanged/);
  } finally {
    await cms.close();
  }
});

test('a .env file is read, and the real environment still wins', async () => {
  const cms = await startCms({ token: 'from-dotenv' });
  const dir = await project({ pages: 'all' });
  await writeFile(join(dir, '.env'), `CMS_ORIGIN=${cms.origin}\nCMS_SITE=georitham\nCMS_TOKEN=from-dotenv\n`);

  try {
    const fromFile = await georithamCms(['manifest'], { cwd: dir });
    assert.equal(fromFile.code, 0, fromFile.stderr);

    // The environment overrides the file, which is what makes CI work.
    const overridden = await georithamCms(['manifest'], {
      cwd: dir,
      env: { CMS_TOKEN: 'wrong' },
    });
    assert.equal(overridden.code, 1);
    assert.match(overridden.stderr, /check the API token/);
  } finally {
    await cms.close();
  }
});

test('the environment overrides the config file, including CMS_PAGES=all', async () => {
  const cms = await startCms({
    pages: [wirePage({ slug: 'landing-page' }), wirePage({ slug: 'about', locale: 'de' })],
  });
  const dir = await project({ out: 'content.json', pages: ['landing-page'] });

  try {
    const env = { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site };

    await georithamCms(['pull'], { cwd: dir, env });
    let snapshot = JSON.parse(await readFile(join(dir, 'content.json'), 'utf8'));
    assert.deepEqual(Object.keys(snapshot.pages), ['landing-page']);

    // "all" has to mean all, not "fall back to whatever the file says".
    await georithamCms(['pull'], { cwd: dir, env: { ...env, CMS_PAGES: 'all' } });
    snapshot = JSON.parse(await readFile(join(dir, 'content.json'), 'utf8'));
    assert.deepEqual(Object.keys(snapshot.pages), ['about', 'landing-page']);

    // And a list overrides it just as directly.
    await georithamCms(['pull'], { cwd: dir, env: { ...env, CMS_PAGES: 'about' } });
    snapshot = JSON.parse(await readFile(join(dir, 'content.json'), 'utf8'));
    assert.deepEqual(Object.keys(snapshot.pages), ['about']);
  } finally {
    await cms.close();
  }
});

test('an unreachable CMS exits 0 and keeps the snapshot', async () => {
  const dir = await project({ out: 'content.json', pages: ['landing-page'] });
  await writeFile(join(dir, 'content.json'), '{"meta":{},"pages":{"kept":{}}}\n');

  const result = await georithamCms(['pull'], {
    cwd: dir,
    env: { CMS_ORIGIN: 'http://127.0.0.1:1', CMS_SITE: 'georitham' },
  });

  assert.equal(result.code, 0, 'a sleeping CMS must not fail a build');
  assert.match(result.stderr, /keeping the committed snapshot/);
  assert.match(await readFile(join(dir, 'content.json'), 'utf8'), /kept/);
});

test('an unreachable CMS with no snapshot to fall back on exits 1', async () => {
  // The same blip, on a fresh clone. Shrugging here hands the build an import
  // of a file that does not exist, and a much worse error than this one.
  const dir = await project({ out: 'content.json', pages: ['landing-page'] });

  const result = await georithamCms(['pull'], {
    cwd: dir,
    env: { CMS_ORIGIN: 'http://127.0.0.1:1', CMS_SITE: 'georitham' },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no snapshot to fall back on/);
});

test('a page missing its required section exits 1 and keeps the snapshot', async () => {
  const cms = await startCms({ pages: [wirePage({ sections: [SECTIONS.faq] })] });
  const dir = await project({
    out: 'content.json',
    pages: ['landing-page'],
    require: { 'landing-page': ['hero'] },
  });
  await writeFile(join(dir, 'content.json'), '{"meta":{},"pages":{"kept":{}}}\n');

  try {
    const result = await georithamCms(['pull'], {
      cwd: dir,
      env: { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no “hero” section/);
    assert.match(result.stderr, /The snapshot was left alone/);
    assert.match(await readFile(join(dir, 'content.json'), 'utf8'), /kept/);
  } finally {
    await cms.close();
  }
});

test('a missing site is a configuration error, not a stack trace', async () => {
  // The one thing a project must supply. The CMS itself needs no configuring.
  const result = await georithamCms(['pull'], { cwd: await project(), env: { CMS_SITE: '' } });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /No website/);
  assert.match(result.stderr, /slug/);
  assert.doesNotMatch(result.stderr, /at Object|at async/);
});

test('with no origin anywhere, it talks to the hosted CMS', async () => {
  // Nothing configured but a site: the request should go to cms.georitham.ch,
  // which from here is a DNS lookup we do not want to make. Asserting on the
  // unreachable error's URL proves where it was headed without going there.
  const { createClient, DEFAULT_ORIGIN } = await import('georitham-cms-sdk');

  assert.equal(DEFAULT_ORIGIN, 'https://cms.georitham.ch');
  assert.equal(
    createClient({ site: 'acme' }).url('manifest/'),
    'https://cms.georitham.ch/api/v1/sites/acme/manifest/',
  );
});

test('a nonsense --interval is refused rather than becoming a tight loop', async () => {
  const cms = await startCms();
  try {
    const result = await georithamCms(['watch', '--interval', 'soon'], {
      cwd: await project(),
      env: { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--interval must be a number of seconds/);
  } finally {
    await cms.close();
  }
});

test('watch pulls once, then again when something is published', async () => {
  const cms = await startCms();
  const dir = await project({ out: 'content.json', pages: ['landing-page'] });

  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--interval', '5'],
    { cwd: dir, env: { ...process.env, CMS_ORIGIN: cms.origin, CMS_SITE: cms.site } },
  );

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });

  try {
    // The first pull happens straight away.
    await until(() => output.includes('content.json updated'), 8000);

    // Then a publish moves the content version, and the next check notices.
    cms.publish();
    await until(() => /published — content version 13/.test(output), 15_000);

    assert.match(output, /Watching georitham — content version 12/);
    assert.match(output, /Checking every 5s/);
  } finally {
    child.kill();
    await cms.close();
  }
});

/** Wait for a condition, or fail with what actually happened. */
async function until(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

test('page prints JSON, and --sections prints an outline', async () => {
  const cms = await startCms();
  const dir = await project();

  try {
    const env = { CMS_ORIGIN: cms.origin, CMS_SITE: cms.site };

    const json = await georithamCms(['page', 'landing-page', '--locale', 'de'], { cwd: dir, env });
    assert.equal(JSON.parse(json.stdout).sections[0].type, 'hero');

    const outline = await georithamCms(['page', 'landing-page', '--sections'], { cwd: dir, env });
    assert.match(outline.stdout, /landing-page {2}de {2}v3/);
    assert.match(outline.stdout, /1\. hero/);
  } finally {
    await cms.close();
  }
});

test('init writes the two files a new project needs, and will not clobber them', async () => {
  const dir = await project();

  const first = await georithamCms(['init', '--site', 'acme', '--page', 'home'], { cwd: dir });
  assert.equal(first.code, 0);

  const config = JSON.parse(await readFile(join(dir, 'georitham.config.json'), 'utf8'));
  assert.deepEqual(config.pages, ['home']);
  assert.equal(config.site, 'acme');
  assert.match(await readFile(join(dir, '.env.example'), 'utf8'), /CMS_SITE=acme/);

  const second = await georithamCms(['init', '--site', 'other'], { cwd: dir });
  assert.match(second.stdout, /kept {5}georitham\.config\.json/);
  const unchanged = JSON.parse(await readFile(join(dir, 'georitham.config.json'), 'utf8'));
  assert.equal(unchanged.site, 'acme');
});
