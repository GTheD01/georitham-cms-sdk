/**
 * georitham-cms-sdk — the client, the types, and the helpers around them.
 *
 *   import { createClient, findSection } from 'georitham-cms-sdk';
 *
 *   const cms = createClient({
 *     site: 'your-site',            // the slug from your dashboard
 *     token: process.env.CMS_TOKEN, // API tokens → create one
 *   });
 *
 *   const page = await cms.page('landing-page', { locale: 'de' });
 *   const hero = findSection(page, 'hero');
 *
 * Nothing in this entry point touches the filesystem, so it runs unchanged in a
 * Cloudflare Worker, a Next.js route, a build script or a browser. The two
 * companions are `georitham-cms-sdk/webhooks` (also edge-safe, and re-exported
 * here) and `georitham-cms-sdk/snapshot` (Node only, because writing files is).
 */

export {
  createClient,
  createMemoryCache,
  CmsClient,
  DEFAULT_CACHE_SIZE,
  DEFAULT_ORIGIN,
  MAX_PAGE_SIZE,
} from './client.js';
export type { ClientOptions, PageListQuery, PageQuery, RequestOptions } from './client.js';

export {
  CmsError,
  CmsAuthError,
  CmsConfigError,
  CmsContentError,
  CmsHttpError,
  CmsNotFoundError,
  CmsResponseError,
  CmsUnreachableError,
  isAuthError,
  isNotFound,
  isUnreachable,
} from './errors.js';
export type { CmsErrorCode } from './errors.js';

export type {
  CacheEntry,
  CacheStore,
  CmsResponse,
  Manifest,
  PageDetail,
  PageList,
  PageSummary,
} from './types.js';

export {
  SECTION_LABELS,
  SECTION_TYPES,
  isKnownSectionType,
} from './sections.js';
export type {
  AnySection,
  CmsLink,
  ContactSection,
  CtaSection,
  FaqItem,
  FaqSection,
  HeroSection,
  PricingPlan,
  PricingSection,
  Section,
  SectionOf,
  SectionType,
  ServiceItem,
  ServicesSection,
  StatItem,
  StatsSection,
  StepItem,
  StepsSection,
  TestimonialItem,
  TestimonialsSection,
  TextSection,
  UnknownSection,
} from './sections.js';

export {
  EMPTY_LINK,
  findSection,
  isSection,
  isUsable,
  requireSection,
  sectionsOfType,
} from './helpers.js';

export { watchContent } from './poll.js';
export type { StopWatching, WatchOptions } from './poll.js';

export * from './webhooks.js';
