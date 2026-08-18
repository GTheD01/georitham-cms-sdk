/**
 * Keep the snapshot up to date while you work.
 *
 *   npm run dev                terminal 1 — the site
 *   npx georitham-cms watch    terminal 2 — this
 *
 * Then click Publish in the dashboard and the browser updates on its own:
 *
 *   Publish ─► content version moves ─► pull ─► the snapshot changes
 *                                                 └─► the dev server reloads
 *
 * It asks rather than waiting to be told, because asking always works. The
 * manifest is a cheap question — one conditional request that answers 304 with
 * no body until somebody publishes — so a few seconds apart costs nothing, and
 * nothing has to be able to reach your machine.
 *
 * For production, where you want a deploy the moment something is published,
 * point a CMS webhook at your own endpoint and verify it with `verifyWebhook`
 * from `georitham-cms-sdk/webhooks`. That is a server you already have; it does
 * not belong in a development command.
 */

import { parseArgs } from 'node:util';
import { relative } from 'node:path';

import { clientFrom, loadConfig, type ResolvedConfig } from '../config.js';
import { isUnreachable } from '../errors.js';
import { writeSnapshot } from '../snapshot.js';

export const WATCH_HELP = `
Usage: georitham-cms watch [options]

  Refresh the snapshot whenever something is published.

Options:
  --interval <n>      seconds between checks    (default: 15, minimum 5)
  --site <slug>       your website              (default: $CMS_SITE)
  --root <dir>        project root              (default: the working directory)
  --origin <url>      a CMS other than the hosted one
`.trim();

export async function watch(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      interval: { type: 'string' },
      site: { type: 'string' },
      root: { type: 'string' },
      origin: { type: 'string' },
    },
  });

  const config = loadConfig({
    root: values.root,
    origin: values.origin,
    site: values.site,
  });

  const seconds = Number(values.interval ?? 15);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Left unchecked this becomes NaN, and `setTimeout(fn, NaN)` fires at once
    // — a typo in a flag turning into a request storm.
    console.error(`--interval must be a number of seconds, not “${values.interval}”.`);
    return 1;
  }

  const intervalMs = Math.max(5, seconds) * 1000;
  const client = clientFrom(config);

  // Ask once up front. A wrong site or a bad token should be said now rather
  // than swallowed into a minute's silence — but a CMS that simply is not
  // answering yet is worth waiting for, since waiting is this command's job.
  let since: number | undefined;
  try {
    since = (await client.manifest()).contentVersion;
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    console.warn(`\nCannot reach the CMS yet — watching anyway.`);
    console.warn(`  ${(error as Error).message}`);
  }

  console.log(
    `\nWatching ${config.site}${since === undefined ? '' : ` — content version ${since}`}.`,
  );
  console.log(`Checking every ${Math.round(intervalMs / 1000)}s. Ctrl-C to stop.\n`);

  await pullOnce(config);

  client.watch(
    {
      intervalMs,
      since,
      // A blip must not end the watch: the next check succeeds and carries on.
      onError: (error) => log((error as Error).message),
    },
    async (next) => {
      log(`published — content version ${next.contentVersion}`);
      await pullOnce(config);
    },
  );

  // Until Ctrl-C.
  await new Promise<never>(() => {});
  return 0;
}

async function pullOnce(config: ResolvedConfig): Promise<void> {
  try {
    const result = await writeSnapshot({
      client: clientFrom(config),
      out: config.outPath,
      pages: config.pages,
      locales: config.locales,
      require: config.require,
    });

    const where = relative(config.root, result.path) || result.path;
    if (result.status === 'unreachable') {
      log(`CMS unreachable — ${where} left alone`);
    } else if (result.changed) {
      log(`${where} updated`);
    }
  } catch (error) {
    // A bad answer must not take the watcher down with it: fix the content,
    // publish again, and the next check picks it up for free.
    log(`refresh failed — snapshot left alone: ${(error as Error).message}`);
  }
}

function log(message: string): void {
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
}
