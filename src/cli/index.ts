#!/usr/bin/env node
/**
 * The `georitham-cms` command.
 *
 * Every subcommand is a thin wrapper over the library, so anything doable here
 * is doable from a script — and the reverse. Nothing is CLI-only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { CmsError } from '../errors.js';
import { init, INIT_HELP } from './init.js';
import { manifest, MANIFEST_HELP, page, PAGE_HELP } from './inspect.js';
import { pull, PULL_HELP } from './pull.js';
import { watch, WATCH_HELP } from './watch.js';

const HELP = `
georitham-cms — content from Georitham CMS

Usage: georitham-cms <command> [options]

  init         write georitham.config.json and .env.example
  pull         fetch the configured pages and write the snapshot
  watch        pull again whenever something is published
  manifest     print your site's publish version, page count and languages
  page <slug>  print one published page as JSON

  georitham-cms <command> --help   for a command's own options

Settings come from, highest first: these flags, the environment (CMS_SITE and
CMS_TOKEN — .env is read for you), then georitham.config.json.
`.trim();

const COMMANDS: Record<string, { run: (argv: string[]) => Promise<number>; help: string }> = {
  init: { run: init, help: INIT_HELP },
  pull: { run: pull, help: PULL_HELP },
  watch: { run: watch, help: WATCH_HELP },
  manifest: { run: manifest, help: MANIFEST_HELP },
  page: { run: page, help: PAGE_HELP },
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log(HELP);
    return name ? 0 : 1;
  }
  if (name === '--version' || name === '-v') {
    console.log(version());
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command “${name}”.\n`);
    console.error(HELP);
    return 1;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(command.help);
    return 0;
  }

  return command.run(rest);
}

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = resolve(here, '../../package.json');
    return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A CMS error already says what went wrong and what to do; a stack trace on
    // top of it is noise. Anything else is a bug and deserves its stack.
    if (error instanceof CmsError) {
      if (error.code === 'unreachable') console.error('\nCould not reach the CMS.');
      console.error(`\n${error.message}`);
      if (error.code === 'content' || error.code === 'not_found') {
        console.error('The snapshot was left alone.');
      }
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
