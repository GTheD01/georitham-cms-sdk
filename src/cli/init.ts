/**
 * The two files a new site needs, so that starting one is not a copy-paste job.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { relative, resolve } from 'node:path';

import { CONFIG_FILENAME, type FileConfig } from '../config.js';

export const INIT_HELP = `
Usage: georitham-cms init [options]

  Write ${CONFIG_FILENAME} and .env.example into the current project.

Options:
  --site <slug>       the website slug
  --out <path>        where the snapshot goes   (default: src/data/content.json)
  --page <slug>       a page to pull; repeatable (default: every published page)
  --root <dir>        project root              (default: the working directory)
  --force             overwrite files that already exist
`.trim();

const ENV_EXAMPLE = `# Copy to .env and fill in. Only \`georitham-cms pull\` and
# \`georitham-cms watch\` read these — the build itself never touches the
# network, it reads the committed snapshot.

# Your website's slug, from the dashboard.
CMS_SITE=%SITE%

# Dashboard → your site → API tokens → create one. Shown once.
# Leave empty only if the site has public reads switched on.
CMS_TOKEN=
`;

export async function init(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      out: { type: 'string' },
      page: { type: 'string', multiple: true },
      root: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  const root = resolve(values.root ?? process.cwd());
  const config: FileConfig = {
    site: values.site ?? 'your-site',
    out: values.out ?? 'src/data/content.json',
    pages: values.page?.length ? values.page : 'all',
    locales: 'configured',
    require: {},
  };

  const written: string[] = [];
  const skipped: string[] = [];

  for (const [name, contents] of [
    [CONFIG_FILENAME, `${JSON.stringify(config, null, 2)}\n`],
    ['.env.example', ENV_EXAMPLE.replace('%SITE%', config.site ?? 'your-site')],
  ] as const) {
    const path = resolve(root, name);
    if (existsSync(path) && !values.force) {
      skipped.push(relative(root, path) || name);
      continue;
    }
    await writeFile(path, contents, 'utf8');
    written.push(relative(root, path) || name);
  }

  for (const name of written) console.log(`wrote    ${name}`);
  for (const name of skipped) console.log(`kept     ${name} (exists — use --force to replace)`);

  console.log(`
Next:
  1. cp .env.example .env, then fill in CMS_SITE and CMS_TOKEN
     (dashboard → your site → API tokens; the token is shown once)
  2. edit ${CONFIG_FILENAME} — which pages to pull, and where they go
  3. npx georitham-cms manifest    check it can see your site
  4. npx georitham-cms pull        write the snapshot, then commit it
`);
  return 0;
}
