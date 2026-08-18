/**
 * Committing the content, so the build never needs the CMS.
 *
 * A snapshot is a JSON file of whole pages, written by `georitham-cms pull` and
 * read by the build. It sounds like a detour and it is the whole point:
 *
 * - a deploy cannot fail, or go half-stale, because the CMS was restarting
 * - the site builds anywhere, including a runner with no route to the CMS at all
 * - `git log src/data/content.json` is a history of what the site actually said
 *
 * Three outcomes, and the difference between them is the design:
 *
 * | Situation                          | Result           | The file  |
 * | ---------------------------------- | ---------------- | --------- |
 * | Fetched and valid                  | `ok`             | rewritten |
 * | CMS unreachable                    | `unreachable`    | kept      |
 * | 404, missing section, bad shape    | throws           | kept      |
 *
 * The middle row is why pulling is its own command rather than part of the
 * build: the CMS being briefly out of reach is not a reason to stop shipping.
 * The last row is the important one — a bad answer must never overwrite a good
 * snapshot, because the snapshot is what deploys.
 *
 * Node only.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { CmsClient } from './client.js';
import {
  CmsConfigError,
  CmsContentError,
  isUnreachable,
  type CmsUnreachableError,
} from './errors.js';
import type { LocaleSelection } from './config.js';
import { findSection } from './helpers.js';
import type { SectionType } from './sections.js';
import type { PageDetail } from './types.js';

export interface SnapshotMeta {
  site: string;
  /**
   * The publish generation the content was last *seen to change* at — not the
   * last time you pulled. An unchanged pull leaves the file alone, so that git
   * stays quiet, which means these two are not the same thing.
   */
  contentVersion: number;
  /** ISO 8601. */
  fetchedAt: string;
  generator: string;
}

export interface Snapshot {
  meta: SnapshotMeta;
  /** `pages[slug][locale]`. */
  pages: Record<string, Record<string, PageDetail>>;
}

export interface WriteSnapshotOptions {
  client: CmsClient;
  /** Where to write. Relative paths resolve against `cwd`. */
  out: string;
  /** Slugs to pull, or every published page. Default `'all'`. */
  pages?: 'all' | string[];
  /** Default `'configured'`. */
  locales?: LocaleSelection;
  /** Sections a page must carry. `'*'` applies to every page. */
  require?: Record<string, SectionType[]>;
  cwd?: string;
  /** Progress, one line at a time. Silent by default. */
  log?: (message: string) => void;
  now?: () => Date;
}

export type SnapshotResult =
  | {
      status: 'ok';
      /** False when the content was identical and the file was left alone. */
      changed: boolean;
      snapshot: Snapshot;
      path: string;
      pageCount: number;
    }
  | { status: 'unreachable'; path: string; error: CmsUnreachableError };

const GENERATOR = 'georitham-cms-sdk';

/** Pull the configured pages and write the snapshot. */
export async function writeSnapshot(options: WriteSnapshotOptions): Promise<SnapshotResult> {
  const { client } = options;
  const cwd = options.cwd ?? process.cwd();
  const path = resolve(cwd, options.out);
  const log = options.log ?? (() => {});

  let collected: Record<string, Record<string, PageDetail>>;
  let contentVersion: number;

  try {
    const manifest = await client.manifest();
    contentVersion = manifest.contentVersion;

    const wanted = await resolveTargets(client, options, {
      configured: manifest.configuredLocales,
      published: manifest.locales,
    });
    collected = await collect(client, wanted, log);
  } catch (error) {
    // The CMS not answering is not a content problem, and the committed
    // snapshot is still perfectly good content.
    if (isUnreachable(error)) return { status: 'unreachable', path, error };
    throw error;
  }

  // The invariant the whole module exists for, stated once where nothing can
  // route around it: an empty pull is never an answer worth writing down.
  if (Object.keys(collected).length === 0) {
    throw new CmsContentError(
      'The pull collected no pages at all — leaving the snapshot alone.',
    );
  }

  enforceRequired(collected, options.require ?? {});

  const previous = await readSnapshotIfPresent(path);
  const changed = JSON.stringify(previous?.pages ?? null) !== JSON.stringify(collected);

  const fresh: SnapshotMeta = {
    site: client.site,
    contentVersion,
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
    generator: GENERATOR,
  };

  const snapshot: Snapshot = {
    // Unchanged content keeps the old provenance: `fetchedAt` records when the
    // words last moved, not when somebody last asked.
    meta: changed ? fresh : (previous?.meta ?? fresh),
    pages: collected,
  };

  if (changed) await writeAtomically(path, `${JSON.stringify(snapshot, null, 2)}\n`);

  return {
    status: 'ok',
    changed,
    snapshot,
    path,
    pageCount: Object.values(collected).reduce(
      (total, locales) => total + Object.keys(locales).length,
      0,
    ),
  };
}

/** Read a snapshot from disk, checking it is one. */
export async function readSnapshot(path: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new CmsContentError(`No snapshot at ${path} — run \`georitham-cms pull\`.`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CmsContentError(`${path} is not valid JSON.`, { cause });
  }

  const snapshot = parsed as Snapshot;
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.pages !== 'object') {
    throw new CmsContentError(`${path} does not look like a snapshot.`);
  }
  return snapshot;
}

/** One page out of a snapshot, or a message that says which ones are in it. */
export function snapshotPage(snapshot: Snapshot, slug: string, locale: string): PageDetail {
  const page = snapshot.pages?.[slug]?.[locale];
  if (!page) {
    const available = Object.entries(snapshot.pages ?? {})
      .map(([key, locales]) => `${key} (${Object.keys(locales).join(', ')})`)
      .join('; ');
    throw new CmsContentError(
      `The snapshot has no “${slug}” in “${locale}”. It has: ${available || 'nothing'}.`,
    );
  }
  return page;
}

// --- the work ---------------------------------------------------------------

interface Target {
  slug: string;
  locales: string[];
  /** Whether a missing locale is an error or simply not translated yet. */
  strict: boolean;
}

async function resolveTargets(
  client: CmsClient,
  options: WriteSnapshotOptions,
  known: { configured: string[]; published: string[] },
): Promise<Target[]> {
  const selection = options.locales ?? 'configured';
  const pages = options.pages ?? 'all';

  // The one rule both branches share: a language asked for by name must be
  // there, one merely configured need not be translated yet.
  const strict = Array.isArray(selection);

  const wanted =
    Array.isArray(selection) ? [...selection].sort()
    : selection === 'published' ? [...known.published].sort()
    : [...known.configured].sort();

  if (strict && wanted.length === 0) {
    throw new CmsConfigError(
      'The language list is empty — name at least one code, or use "configured"/"published".',
    );
  }

  if (pages === 'all') {
    // Everything published, grouped — no guessing which languages exist, and
    // no wasted 404s.
    const allowed = new Set(wanted);

    const grouped = new Map<string, Set<string>>();
    for await (const summary of client.allPages()) {
      if (!allowed.has(summary.locale)) continue;
      const locales = grouped.get(summary.slug) ?? new Set<string>();
      locales.add(summary.locale);
      grouped.set(summary.slug, locales);
    }

    if (grouped.size === 0) {
      throw new CmsContentError(
        'The site has no published pages in the selected languages — nothing to snapshot.',
      );
    }

    // Discovery finds which pages exist; naming the languages still says which
    // ones every one of them must have. Otherwise this branch would quietly
    // skip a missing translation that an explicit page list would 404 on.
    return [...grouped].map(([slug, locales]) => ({
      slug,
      locales: strict ? wanted : [...locales].sort(),
      strict,
    }));
  }

  if (pages.length === 0) {
    throw new CmsConfigError(
      'The page list is empty — name at least one slug, or use "all". ' +
        'Pulling nothing would replace the snapshot with nothing.',
    );
  }

  if (wanted.length === 0) {
    throw new CmsContentError('No languages to pull — the site has none published.');
  }

  return pages.map((slug) => ({ slug, locales: wanted, strict }));
}

async function collect(
  client: CmsClient,
  targets: Target[],
  log: (message: string) => void,
): Promise<Record<string, Record<string, PageDetail>>> {
  const collected: Record<string, Record<string, PageDetail>> = {};

  for (const target of [...targets].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const byLocale: Record<string, PageDetail> = {};

    for (const locale of target.locales) {
      const page = target.strict
        ? await client.page(target.slug, { locale })
        : await client.tryPage(target.slug, { locale });

      if (!page) continue;
      byLocale[locale] = page;
      log(`  ${locale}  ${target.slug} — ${page.title}`);
    }

    if (Object.keys(byLocale).length === 0) {
      throw new CmsContentError(
        `“${target.slug}” is not published in any of: ${target.locales.join(', ')}.`,
      );
    }
    collected[target.slug] = byLocale;
  }

  return collected;
}

function enforceRequired(
  collected: Record<string, Record<string, PageDetail>>,
  required: Record<string, SectionType[]>,
): void {
  for (const [slug, locales] of Object.entries(collected)) {
    const types = [...(required['*'] ?? []), ...(required[slug] ?? [])];
    if (types.length === 0) continue;

    for (const [locale, page] of Object.entries(locales)) {
      for (const type of types) {
        if (findSection(page, type)) continue;
        const present = page.sections.map((section) => section.type).join(', ') || 'none';
        throw new CmsContentError(
          `The ${locale} “${slug}” page has no “${type}” section (it has: ${present}).`,
        );
      }
    }
  }
}

async function readSnapshotIfPresent(path: string): Promise<Snapshot | null> {
  try {
    return await readSnapshot(path);
  } catch {
    // No snapshot yet, or an unreadable one. Either way the next write fixes it.
    return null;
  }
}

/**
 * Write via a neighbouring temp file and a rename.
 *
 * `rename` is atomic within a filesystem, so an interrupted pull leaves the
 * previous snapshot intact rather than a truncated one — and a truncated
 * snapshot is a broken build that looks like a content bug.
 */
async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;

  try {
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
