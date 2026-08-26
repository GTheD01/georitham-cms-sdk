# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-27

### Added

- **Sections** — `ServiceItem` gains `points`, the long form of the same
  service for a page that renders the list twice, and `featured`, matching the
  flag `PricingPlan` already carried. `PricingPlan` gains `badge`, the label
  shown above the plan name ("Most booked", "New").

### Notes

- The three new fields are required rather than optional: the CMS always sends
  them, empty where an editor left them blank, so they can be read without a
  presence check. Code that only reads sections off a page is unaffected;
  anything that constructs a `ServiceItem` or `PricingPlan` literal — test
  fixtures, mocks — needs to add them.

## [0.1.0] — 2026-08-18

Initial public release.

### Added

- **Client** — `createClient` / `CmsClient` with `page`, `tryPage`, `pages`,
  `hasChanged`, `watch`, `url` and a general `request`. ETag-aware: a
  `304 Not Modified` is served from cache without re-parsing the body. The default
  cache is a bounded LRU (`createMemoryCache`, `DEFAULT_CACHE_SIZE`), and any
  `CacheStore` can be supplied instead.
- **Pagination** — `allPages` is an async generator that walks every page across
  requests, skipping duplicates and tolerating server count mismatches.
  `MAX_PAGE_SIZE` caps a single request.
- **Errors** — a typed hierarchy rooted at `CmsError`: `CmsAuthError`,
  `CmsConfigError`, `CmsContentError`, `CmsHttpError`, `CmsNotFoundError`,
  `CmsResponseError`, `CmsUnreachableError`, plus the `isAuthError`, `isNotFound`
  and `isUnreachable` guards.
- **Sections** — full types for every section kind (hero, text, services, pricing,
  faq, stats, steps, testimonials, cta, contact), with `SECTION_TYPES`,
  `SECTION_LABELS` and `isKnownSectionType`. Unknown types degrade to
  `UnknownSection` rather than failing.
- **Section helpers** — `findSection`, `requireSection`, `sectionsOfType`,
  `isSection`, `isUsable`, `EMPTY_LINK`.
- **Polling** — `watchContent` re-checks the manifest on an interval and reports
  changes; returns a `StopWatching` handle.
- **Snapshots** — `georitham-cms-sdk/snapshot` provides `writeSnapshot`,
  `readSnapshot` and `snapshotPage`. `writeSnapshot` returns a discriminated
  `SnapshotResult`: `status: 'ok'` carries a `changed` flag so an unchanged file is
  left alone, while `status: 'unreachable'` lets a build fall back to the last good
  copy instead of breaking.
- **Webhooks** — `georitham-cms-sdk/webhooks` provides `verifyWebhook`,
  `isValidSignature`, `signWebhook`, `parseWebhookEvent` and `readHeader`, plus the
  header-name constants and `WEBHOOK_EVENTS`. Signatures are compared in constant
  time, replays outside `DEFAULT_TOLERANCE_SECONDS` (300s) are rejected, and all
  three header-source shapes are accepted. Edge-safe, and re-exported from the main
  entry point.
- **CLI** — `georitham-cms` with `init`, `pull`, `watch`, `manifest` and `page`.
  The `CMS_ORIGIN` environment variable overrides the default origin.

### Notes

- Zero runtime dependencies. ESM only. Requires Node 20 or newer.
- The main entry point uses `fetch` and nothing else — no `node:` builtins — so it
  runs unchanged in a Cloudflare Worker, a Next.js route, a build script or a
  browser. Only `georitham-cms-sdk/snapshot` and the CLI require Node.

[0.2.0]: https://github.com/GTheD01/georitham-cms-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/GTheD01/georitham-cms-sdk/releases/tag/v0.1.0
