# georitham-cms-sdk

[![npm](https://img.shields.io/npm/v/georitham-cms-sdk.svg)](https://www.npmjs.com/package/georitham-cms-sdk)
[![CI](https://github.com/GTheD01/georitham-cms-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/GTheD01/georitham-cms-sdk/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/npm/l/georitham-cms-sdk.svg)](LICENSE)

The official client for **Georitham CMS** — a headless CMS whose pages are
ordered lists of *sections*, not documents.

```bash
npm install georitham-cms-sdk
```

```ts
import { createClient, findSection } from 'georitham-cms-sdk';

const cms = createClient({
  site: 'your-site',            // your website's slug
  token: process.env.CMS_TOKEN, // dashboard → API tokens
});

const page = await cms.page('landing-page', { locale: 'de' });
const hero = findSection(page, 'hero'); // fully typed
```

That is the whole setup. There is no URL to configure: the client talks to
`https://cms.georitham.ch`, and `site` is the only thing that identifies you.

Zero dependencies, ESM only, TypeScript throughout. The main entry point is
`fetch` and nothing else, so the same import works in a build script, a Next.js
route, a Cloudflare Worker or a browser. Two companions do the parts that are
not universal: `georitham-cms-sdk/snapshot` writes files, and
`georitham-cms-sdk/webhooks` verifies deliveries (edge-safe, and re-exported
from the main entry).

The API is read-only. Content is edited in the dashboard; this package reads it.

## What you need from the dashboard

| | Where | Notes |
|---|---|---|
| **Site slug** | the address bar of your site in the dashboard | e.g. `acme` in `/dashboard/sites/acme/` |
| **API token** | your site → **API tokens** → create | Shown once. Scoped to that one site, read-only |
| **Page slug** | your site → **Pages** | What you pass to `cms.page(slug)` |

A site with **public reads** switched on needs no token at all — leave it out.

## Two ways to use it, both supported

**Build a snapshot, deploy that.** `georitham-cms pull` writes a JSON file, you
commit it, and the build reads it. The build never touches the network, so a
deploy cannot fail or go half-stale because the CMS was restarting, and
`git log` becomes a history of what your site actually said. This is the default
for static sites.

**Fetch at request time.** Call the client from a server route and let the ETag
cache, or your framework's, do the work. A conditional request costs a 304 with
no body until somebody publishes.

Nothing here forces the choice, and mixing them is fine.

## The client

```ts
const cms = createClient({
  site: 'your-site',
  token: process.env.CMS_TOKEN, // omit if public reads are on
  timeout: 10_000,              // per request; 0 disables
  cache: true,                  // ETag cache: true, false, or your own store
  fetch: myFetch,               // injectable
  headers: {},                  // extras on every request
  origin: '…',                  // only to reach a different CMS
});
```

| Call | What it does |
|---|---|
| `manifest()` | Publish version, page count, languages. One cheap call. |
| `pages({locale, page, pageSize})` | One page of the page listing. |
| `allPages({locale})` | Async iterator; follows pagination to the end. |
| `page(slug, {locale})` | One published page, with its sections. Throws on 404. |
| `tryPage(slug, {locale})` | The same, but `null` where `page()` would throw. |
| `hasChanged(version)` | Has anything been published since? |
| `watch({intervalMs}, cb)` | Poll for publishes. Returns a `stop()`. Delivery is at least once, so make `cb` idempotent. |
| `request(path, opts)` | Any path, raw payload, full response. |

`request()` is the escape hatch, and it is deliberately public: it has the same
auth, timeouts, error handling and caching as everything above, so when the API
grows something this package has not learned yet, it is still one call away.

```ts
const { data, etag, contentVersion, status } = await cms.request('manifest/');
data.content_version; // the wire format, untranslated
```

### Caching

Every response carries an ETag derived from your site's publish generation, so
a repeat request costs a 304 with no body until somebody publishes. The built-in
cache holds the 200 most recently used responses and evicts the rest — bounded
on purpose, because a server rendering pages on demand would otherwise keep one
entry per slug and locale it is ever asked for, forever.

```ts
import { createClient, createMemoryCache } from 'georitham-cms-sdk';

createClient({ site, cache: createMemoryCache(2000) }); // a bigger site
createClient({ site, cache: false });                   // let the framework cache
createClient({ site, cache: myKvStore });               // anything with get/set/delete
```

### Naming

Envelope keys are camelCased — `content_version` becomes `contentVersion`.
**Section content is passed through untouched**, because those keys belong to
your content rather than to the transport: `headingLead` is what the field is
called in the dashboard, and renaming it here would put this package between you
and your own words.

Timestamps stay ISO 8601 strings so a payload survives a round trip through
`JSON.stringify` into a committed snapshot unchanged.

### Errors

The distinction that decides what a caller does:

| Class | `code` | Cause |
|---|---|---|
| `CmsUnreachableError` | `unreachable` | DNS, refused, TLS, timeout, a connection that dies mid-answer — **not a failure** |
| `CmsAuthError` | `auth` | 401, 403 — wrong, revoked or missing token |
| `CmsNotFoundError` | `not_found` | 404 — unpublished, wrong slug, wrong language |
| `CmsResponseError` | `response` | any other non-2xx |
| `CmsContentError` | `content` | the answer arrived and is wrong |
| `CmsConfigError` | `config` | nothing was configured to call, or it was configured wrong |

An answer that stops halfway is `unreachable`, not `content`: the CMS did not
finish speaking, which is a blip to shrug at rather than a reason to throw away
good content. A 404 on the *manifest* is a `CmsConfigError` for the same kind of
reason — every site has a manifest, so the site slug is wrong or the token
belongs to a different one.

```ts
import { isUnreachable } from 'georitham-cms-sdk';

try {
  await refresh();
} catch (error) {
  if (isUnreachable(error)) return keepWhatWeHave(); // a blip, not a failure
  throw error;
}
```

Every error carries `code` as well as its class, because `instanceof` breaks
when two copies of a package end up in one dependency tree and a string does
not.

## Sections

Ten section types, as a discriminated union on `type`: `hero`, `text`,
`services`, `steps`, `stats`, `testimonials`, `pricing`, `faq`, `cta`,
`contact`. They mirror the schema the dashboard's editor is built from, which is
also what the CMS validates against — the reference is under **Integration** in
the dashboard.

Two guarantees shape the types, and both matter when writing a component:

1. **Nothing is ever missing.** Validation fills every declared field on the way
   in, so an unfilled slot arrives as `""`, `[]`, `false` or
   `{label: "", href: ""}` — never `undefined`. No field is optional and no
   component needs to guard.
2. **Empty is not absent.** An empty string means an editor left a real field
   blank. Decide what to render; do not assume the API forgot.

```ts
import { findSection, requireSection, sectionsOfType, isUsable } from 'georitham-cms-sdk';

const hero = requireSection(page, 'hero');  // or a readable throw
const faqs = sectionsOfType(page, 'faq');   // all of them, in page order

{isUsable(hero.ctaSecondary) && <a href={hero.ctaSecondary.href}>…</a>}
```

`page.sections` is typed loosely — the known union plus an open
`{type: string, …}` — so a CMS that grows an eleventh section type does not
break a site built against an older version of this package. It still arrives,
still snapshots and still renders; it is simply untyped until the next release
here. Narrow with the helpers above.

## Snapshots

```ts
import { writeSnapshot, readSnapshot, snapshotPage } from 'georitham-cms-sdk/snapshot';

await writeSnapshot({
  client: cms,
  out: 'src/data/content.json',
  pages: ['landing-page'],              // or 'all'
  locales: 'configured',                // or 'published', or ['de', 'en']
  require: { 'landing-page': ['hero'] },// sections the page must have
});
```

Writes `{ meta, pages: { [slug]: { [locale]: PageDetail } } }` — whole pages, so
adding a section type to your site needs no change to the tooling. Three
outcomes, and the difference between them is the whole design:

| Situation | Result | The file |
|---|---|---|
| Fetched and valid | `{status: 'ok', changed}` | rewritten |
| CMS unreachable | `{status: 'unreachable'}`, no throw | kept |
| 404, missing required section, bad shape | throws | kept |
| Nothing to pull — an empty `pages` or `locales` list | throws | kept |

The middle row is why pulling is its own command rather than part of the build.
The last two are the important ones: **a bad answer must never overwrite a good
snapshot**, because the snapshot is what deploys — and no answer at all is the
worst answer of the lot.

Naming languages means asking for them: `locales: ['de', 'fr']` makes a page
that is not translated into French a failure, whether you listed the pages by
slug or used `'all'`. `'configured'` and `'published'` are the lenient
selections — a language with nothing live in it yet is simply skipped.

An unchanged pull leaves the file alone entirely, so `git status` stays clean.
Writes go through a temp file and a rename, so an interrupted pull cannot leave
a truncated snapshot behind.

## Webhooks

The CMS can POST to your server the moment anything is published — the usual
reason being "rebuild and deploy the site". Each delivery is signed with
HMAC-SHA256 over `` `${timestamp}.${body}` ``; the timestamp is inside the
signed material, which is what stops a captured delivery being replayed later.

Add the endpoint under **Webhooks** in your site's dashboard, copy its signing
secret, and verify like this:

```ts
import { verifyWebhook } from 'georitham-cms-sdk/webhooks';

export default {
  async fetch(request, env, ctx) {
    const body = await request.text(); // the raw body — parse it afterwards
    const event = await verifyWebhook({
      body,
      headers: request.headers,
      secret: env.CMS_WEBHOOK_SECRET,
    });

    // Answer before working: a delivery still open after ten seconds is
    // retried, which would start the job twice.
    ctx.waitUntil(rebuild(event));
    return new Response(null, { status: 202 });
  },
};
```

WebCrypto only, so one implementation covers Workers, Node, Deno and Bun.
`headers` takes a `Headers`, a plain object or Node's `IncomingHttpHeaders`.
Failures throw `WebhookVerificationError`, and the right answer to all of them
is `401` — which the CMS treats as a refusal rather than something to retry.

Verify the **raw** body. Parsing and re-encoding changes the bytes and the
signature will never match again.

## The CLI

```
georitham-cms init         write georitham.config.json and .env.example
georitham-cms pull         fetch the pages and write the snapshot
georitham-cms watch        pull again whenever something is published
georitham-cms manifest     publish version, page count, languages
georitham-cms page <slug>  print one page as JSON — pipe it into jq
```

Settings come from, highest first: the flags, the environment (`.env` is read
for you), then `georitham.config.json`. Which site and which token are yours;
which pages and where they go are the project's, so they are committed:

```jsonc
// georitham.config.json — committed
{
  "out": "src/data/content.json",
  "pages": ["landing-page"],            // or "all"
  "locales": "configured",              // or "published", or ["de", "en"]
  "require": { "landing-page": ["hero"] }
}
```

```bash
# .env — never committed
CMS_SITE=your-site
CMS_TOKEN=…
```

`pull` exits **0** when the snapshot is written, unchanged, *or* the CMS was
unreachable and the committed snapshot is still there to build from. It exits
**1** when the CMS answered with something wrong — and when it was unreachable
with no snapshot to fall back on, since there is nothing to carry on with. That
is the contract a CI pipeline runs on.

An empty value is not an answer: `CMS_SITE=` in a CI environment where the
secret is not set yet falls through to `georitham.config.json` rather than
shadowing it.

### While you work

```bash
npm run dev              # terminal 1 — your site
npx georitham-cms watch  # terminal 2
```

Click **Publish** in the dashboard and the snapshot refreshes on its own, which
your dev server picks up as a file change. It asks every fifteen seconds
(`--interval` to change that) rather than waiting to be told, because asking
always works — a manifest check is one conditional request that answers 304 with
no body until something actually changes.

Webhooks are for your *deployed* site, where you have a server that can be
reached; see above.

## Pointing somewhere else

`origin` and `CMS_ORIGIN` exist for the cases where the CMS is not the hosted
one — a self-hosted instance, a staging copy, or a local instance while working
on the CMS itself:

```bash
CMS_ORIGIN=http://127.0.0.1:8000 npx georitham-cms pull
```

Most projects never set it.

## Contributing

Bugs and feature requests go to
[the issue tracker](https://github.com/GTheD01/georitham-cms-sdk/issues).

To work on the SDK itself:

```bash
npm ci
npm test        # builds, then runs the suite against a local fixture server
```

Requires Node 20 or newer. Changes worth mentioning belong in
[CHANGELOG.md](CHANGELOG.md).

## Licence

MIT.
