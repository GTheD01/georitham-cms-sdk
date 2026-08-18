/**
 * Where the settings come from, and which one wins.
 *
 * Two kinds of setting, kept apart on purpose:
 *
 * - **Which site, and the token for it** live in the environment (`.env`
 *   locally, real variables in CI): `CMS_SITE` and `CMS_TOKEN`. One is an
 *   identifier, the other is a secret; neither belongs in a committed file.
 * - **Shape** lives in `georitham.config.json`, committed: which pages, which
 *   languages, where the snapshot goes, which sections a page must have. It is
 *   the same for everyone working on the site, so it belongs in the repository.
 *
 * Precedence, highest first: explicit arguments, the environment,
 * `georitham.config.json`, then defaults. Nothing has to name the CMS itself —
 * `CMS_ORIGIN` exists only to point at a different one.
 *
 * Node only — this reads files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { CmsConfigError } from './errors.js';
import { createClient, DEFAULT_ORIGIN, type CmsClient } from './client.js';
import type { SectionType } from './sections.js';

export const CONFIG_FILENAME = 'georitham.config.json';

/** Which languages to pull. */
export type LocaleSelection =
  /** Every language the site is set up for; ones with nothing live are skipped. */
  | 'configured'
  /** Only languages that already have something published. */
  | 'published'
  /** Exactly these, and a missing one is an error. */
  | string[];

export interface FileConfig {
  /** Your website's slug. Usually in `.env` instead, as `CMS_SITE`. */
  site?: string;
  /** Where the snapshot is written, relative to the config file. */
  out?: string;
  /** Page slugs, or `"all"`. */
  pages?: 'all' | string[];
  locales?: LocaleSelection;
  /** Sections a page must have. `"*"` applies to every page. */
  require?: Record<string, SectionType[]>;
  /** A CMS other than the hosted one. Rarely needed. */
  origin?: string;
}

export interface ResolvedConfig extends Required<Omit<FileConfig, 'origin' | 'site'>> {
  origin: string;
  site: string;
  token: string | undefined;
  /** Absolute, resolved against the project root. */
  outPath: string;
  root: string;
  configPath: string | null;
}

const DEFAULTS = {
  out: 'src/data/content.json',
  pages: 'all' as const,
  locales: 'configured' as LocaleSelection,
  require: {} as Record<string, SectionType[]>,
};

/**
 * Read `.env` files into `process.env`, without a dependency.
 *
 * Four variables do not justify one, and `--env-file` is not reliably
 * available to `npm run` on every machine a project gets cloned onto. Values
 * already in the environment win, which is what makes CI work: it sets them
 * directly and there is no file to read.
 */
export function loadEnv(root: string = process.cwd()): void {
  // Local overrides first: whoever is read first wins, and `.env.local` is the
  // one meant to override.
  for (const name of ['.env.local', '.env']) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;

      const [, key, rawValue] = match as unknown as [string, string, string];
      if (key.startsWith('#') || process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }
}

export function readConfigFile(root: string): { config: FileConfig; path: string | null } {
  const path = resolve(root, CONFIG_FILENAME);
  if (!existsSync(path)) return { config: {}, path: null };

  try {
    return { config: JSON.parse(readFileSync(path, 'utf8')) as FileConfig, path };
  } catch (cause) {
    throw new CmsConfigError(`${CONFIG_FILENAME} is not valid JSON: ${String(cause)}`);
  }
}

export interface LoadConfigOptions extends FileConfig {
  /** Project root. Defaults to the working directory. */
  root?: string;
  token?: string;
  /** Skip reading `.env` — CI has already set what it needs. */
  skipEnvFile?: boolean;
}

/** Merge the three sources into one settled configuration. */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const root = resolve(options.root ?? process.cwd());
  if (!options.skipEnvFile) loadEnv(root);

  const { config: file, path: configPath } = readConfigFile(root);
  const env = process.env;

  const origin = firstSet(options.origin, env.CMS_ORIGIN, file.origin) ?? DEFAULT_ORIGIN;
  const site = firstSet(options.site, env.CMS_SITE, file.site) ?? '';

  if (!site) {
    throw new CmsConfigError(
      'No website. Set CMS_SITE in .env, or "site" in ' +
        CONFIG_FILENAME +
        ' — it is your\nwebsite’s slug, the one in the dashboard’s address bar.',
    );
  }

  const out = firstSet(options.out, env.CMS_OUT, file.out) ?? DEFAULTS.out;
  const pages = options.pages ?? parsePages(env.CMS_PAGES) ?? file.pages ?? DEFAULTS.pages;
  const locales =
    options.locales ?? parseLocales(env.CMS_LOCALES) ?? file.locales ?? DEFAULTS.locales;

  if (Array.isArray(pages) && pages.length === 0) {
    throw new CmsConfigError(
      `An empty "pages" list in ${CONFIG_FILENAME} would pull nothing — name at least one slug, or use "all".`,
    );
  }
  if (Array.isArray(locales) && locales.length === 0) {
    throw new CmsConfigError(
      `An empty "locales" list in ${CONFIG_FILENAME} would pull nothing — name at least one code, or use "configured".`,
    );
  }

  return {
    origin: origin.replace(/\/+$/, ''),
    site,
    token: firstSet(options.token, env.CMS_TOKEN),
    out,
    outPath: isAbsolute(out) ? out : resolve(root, out),
    pages,
    locales,
    require: options.require ?? file.require ?? DEFAULTS.require,
    root,
    configPath,
  };
}

/** A client built from a resolved configuration. */
export function clientFrom(
  config: ResolvedConfig,
  options: { fetch?: typeof globalThis.fetch; timeout?: number } = {},
): CmsClient {
  return createClient({
    origin: config.origin,
    site: config.site,
    token: config.token,
    ...options,
  });
}

/**
 * The first source that actually says something.
 *
 * CI sets a variable from a secret that is not there yet and gets an empty
 * string, not an absent one. Treating that as an answer means `CMS_SITE=""`
 * shadows a perfectly good site in the config file, and `CMS_OUT=""` points the
 * snapshot at the project directory itself. Blank means unset, everywhere.
 */
function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '');
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** `CMS_PAGES=all` has to mean *all*, not "fall through to the config file". */
function parsePages(value: string | undefined): 'all' | string[] | undefined {
  if (value?.trim() === 'all') return 'all';
  return parseList(value);
}

function parseLocales(value: string | undefined): LocaleSelection | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === 'configured' || trimmed === 'published') return trimmed;
  return parseList(value);
}
