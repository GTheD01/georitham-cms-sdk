/**
 * Looking at the CMS without writing anything.
 *
 * `georitham-cms manifest` is the five-second answer to "is the site slug right, is
 * the token right, is anything published" — the three things wrong at the start
 * of most integrations.
 */

import { parseArgs } from 'node:util';

import { clientFrom, loadConfig } from '../config.js';

export const MANIFEST_HELP = `
Usage: georitham-cms manifest [options]

  Print the site manifest: publish version, page count, languages.

Options:
  --json              print the raw JSON instead of a summary
  --site, --root, --origin      as for \`pull\`
`.trim();

export const PAGE_HELP = `
Usage: georitham-cms page <slug> [options]

  Print one published page as JSON. Pipe it into jq.

Options:
  --locale <code>     which language        (default: the site's own default)
  --sections          list section types instead of the whole page
  --site, --root, --origin      as for \`pull\`
`.trim();

export async function manifest(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      origin: { type: 'string' },
      site: { type: 'string' },
      root: { type: 'string' },
    },
  });

  const config = loadConfig({ root: values.root, origin: values.origin, site: values.site });
  const result = await clientFrom(config).manifest();

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`site               ${result.site}   (${config.origin})`);
  console.log(`content version    ${result.contentVersion}`);
  console.log(`published pages    ${result.pageCount}`);
  console.log(`published in       ${result.locales.join(', ') || 'nothing yet'}`);
  console.log(
    `configured for     ${result.configuredLocales.join(', ')}   default ${result.defaultLocale}`,
  );

  const untranslated = result.configuredLocales.filter(
    (locale) => !result.locales.includes(locale),
  );
  if (untranslated.length) {
    console.log(`\nSet up but nothing published yet: ${untranslated.join(', ')}.`);
  }
  return 0;
}

export async function page(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      locale: { type: 'string' },
      sections: { type: 'boolean', default: false },
      origin: { type: 'string' },
      site: { type: 'string' },
      root: { type: 'string' },
    },
  });

  const slug = positionals[0];
  if (!slug) {
    console.error(PAGE_HELP);
    return 1;
  }

  const config = loadConfig({ root: values.root, origin: values.origin, site: values.site });
  const detail = await clientFrom(config).page(slug, { locale: values.locale });

  if (values.sections) {
    console.log(`${detail.slug}  ${detail.locale}  v${detail.version}  “${detail.title}”`);
    console.log(`translations: ${detail.translations.join(', ')}`);
    detail.sections.forEach((section, index) => {
      console.log(`  ${index + 1}. ${section.type}`);
    });
    return 0;
  }

  console.log(JSON.stringify(detail, null, 2));
  return 0;
}
