import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { relative } from 'node:path';

import { clientFrom, loadConfig } from '../config.js';
import { writeSnapshot } from '../snapshot.js';

export const PULL_HELP = `
Usage: georitham-cms pull [options]

  Fetch the configured pages and write the snapshot the build reads.

Options:
  --out <path>        where to write            (default: src/data/content.json)
  --page <slug>       a page to pull; repeatable, overrides the config file
  --locale <code>     a language to pull; repeatable, or "configured"/"published"
  --site <slug>       your website              (default: $CMS_SITE)
  --root <dir>        project root              (default: the working directory)
  --quiet             only report the outcome
  --origin <url>      a CMS other than the hosted one

Exit codes:
  0   snapshot written, unchanged, or the CMS was unreachable and the
      committed snapshot is still there to build from
  1   the CMS answered with something wrong — the snapshot was left alone —
      or it was unreachable with no snapshot to fall back on
`.trim();

export async function pull(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      page: { type: 'string', multiple: true },
      locale: { type: 'string', multiple: true },
      origin: { type: 'string' },
      site: { type: 'string' },
      root: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
  });

  const config = loadConfig({
    root: values.root,
    origin: values.origin,
    site: values.site,
    out: values.out,
    pages: values.page?.length ? values.page : undefined,
    locales: values.locale?.length ? readLocales(values.locale) : undefined,
  });

  const result = await writeSnapshot({
    client: clientFrom(config),
    out: config.outPath,
    pages: config.pages,
    locales: config.locales,
    require: config.require,
    log: values.quiet ? undefined : (line) => console.log(line),
  });

  const where = relative(config.root, result.path) || result.path;

  if (result.status === 'unreachable') {
    // Not a failure: a restart, a network blip, no route from this machine —
    // and the committed snapshot is still perfectly good content. Unless there
    // is none, in which case shrugging hands the build an empty import and a
    // much worse error than this one.
    if (!existsSync(result.path)) {
      console.error(`\nCMS unreachable, and there is no snapshot to fall back on.`);
      console.error(`  ${result.error.message}`);
      console.error(`\nNothing was written to ${where}.`);
      return 1;
    }

    console.warn(`\nCMS unreachable — keeping the committed snapshot.`);
    console.warn(`  ${result.error.message}`);
    return 0;
  }

  if (result.changed) {
    console.log(
      `\nSnapshot updated from content version ${result.snapshot.meta.contentVersion}.`,
    );
    console.log(`Commit ${where} to deploy it.`);
  } else {
    console.log(
      `\nSnapshot unchanged (content version ${result.snapshot.meta.contentVersion}).`,
    );
  }
  return 0;
}

/** `--locale configured` is a selection; anything else is a list of codes. */
function readLocales(values: string[]): string[] | 'configured' | 'published' {
  const first = values[0];
  if (values.length === 1 && (first === 'configured' || first === 'published')) {
    return first;
  }
  return values;
}
