/**
 * The content vocabulary, in TypeScript.
 *
 * These mirror the CMS's own section schema — the single declaration that also
 * drives validation and the editor form, and which the dashboard documents
 * under Integration. When the CMS grows a section type this file has not
 * learned yet, it still arrives, still snapshots and still renders; it is
 * simply untyped until the next release here.
 *
 * Two guarantees from the CMS shape everything below, and both are worth
 * knowing before you write a component:
 *
 * 1. **Nothing is ever missing.** Validation fills every declared field on the
 *    way in, so an unfilled slot arrives as `""`, `[]`, `false`, or
 *    `{label: "", href: ""}` — never `undefined`. That is why no field here is
 *    optional and why no component needs to guard.
 * 2. **Empty is not the same as absent.** An empty string means an editor left
 *    a real field blank. Decide what to render; do not assume the API forgot.
 *
 * Every field is text. Images are deliberately not supported yet.
 */

/** A call to action. Both halves can be empty; see `isUsable`. */
export interface CmsLink {
  label: string;
  href: string;
}

interface SectionBase<T extends string> {
  type: T;
}

/** The opening of a page. One per page is plenty. */
export interface HeroSection extends SectionBase<'hero'> {
  eyebrow: string;
  /**
   * The headline arrives in halves so the accent can be a real colour on a
   * real element, rather than a gradient that risks rendering invisible.
   */
  headingLead: string;
  headingAccent: string;
  body: string;
  trust: string[];
  ctaPrimary: CmsLink;
  ctaSecondary: CmsLink;
}

/** A heading and prose — an about page, a policy, a note. */
export interface TextSection extends SectionBase<'text'> {
  heading: string;
  body: string;
}

export interface ServiceItem {
  title: string;
  body: string;
  link: CmsLink;
  /**
   * The long form of the same service, for a page that shows the list twice:
   * `body` sells it, these say what is actually done. Empty where an editor
   * only wanted the blurb.
   */
  points: string[];
  featured: boolean;
}

export interface ServicesSection extends SectionBase<'services'> {
  heading: string;
  intro: string;
  items: ServiceItem[];
}

export interface StepItem {
  title: string;
  body: string;
}

/** How it works. Numbered by the frontend, in the order they are arranged. */
export interface StepsSection extends SectionBase<'steps'> {
  heading: string;
  intro: string;
  items: StepItem[];
}

export interface StatItem {
  value: string;
  label: string;
}

export interface StatsSection extends SectionBase<'stats'> {
  heading: string;
  items: StatItem[];
}

export interface TestimonialItem {
  quote: string;
  author: string;
  role: string;
  company: string;
}

export interface TestimonialsSection extends SectionBase<'testimonials'> {
  heading: string;
  items: TestimonialItem[];
}

export interface PricingPlan {
  name: string;
  /** Text, not a number: “from CHF 4,900” and “on request” both belong here. */
  price: string;
  period: string;
  description: string;
  features: string[];
  cta: CmsLink;
  featured: boolean;
  /** “Most booked”, “New”. Shown above the name; empty on most plans. */
  badge: string;
}

export interface PricingSection extends SectionBase<'pricing'> {
  heading: string;
  intro: string;
  note: string;
  items: PricingPlan[];
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqSection extends SectionBase<'faq'> {
  heading: string;
  intro: string;
  items: FaqItem[];
}

/** The closing ask at the end of a page. */
export interface CtaSection extends SectionBase<'cta'> {
  heading: string;
  body: string;
  ctaPrimary: CmsLink;
  ctaSecondary: CmsLink;
}

export interface ContactSection extends SectionBase<'contact'> {
  heading: string;
  body: string;
  email: string;
  phone: string;
  address: string;
  cta: CmsLink;
}

/** Every section type this SDK knows, as a discriminated union on `type`. */
export type Section =
  | HeroSection
  | TextSection
  | ServicesSection
  | StepsSection
  | StatsSection
  | TestimonialsSection
  | PricingSection
  | FaqSection
  | CtaSection
  | ContactSection;

export type SectionType = Section['type'];

/**
 * A section this SDK has never heard of.
 *
 * A CMS that grows an eleventh section type must not break a site built
 * against an older SDK, so `page.sections` is typed loosely and narrowed by
 * `findSection`. An unknown section is data, not an error — render it or skip
 * it, but a build should not fall over because someone added a section type.
 */
export interface UnknownSection {
  type: string;
  [field: string]: unknown;
}

export type AnySection = Section | UnknownSection;

/** Narrow `AnySection` to one member of the union. */
export type SectionOf<T extends SectionType> = Extract<Section, { type: T }>;

/** Every known type, in the order the CMS declares them. */
export const SECTION_TYPES = [
  'hero',
  'text',
  'services',
  'steps',
  'stats',
  'testimonials',
  'pricing',
  'faq',
  'cta',
  'contact',
] as const satisfies readonly SectionType[];

/** Human labels, matching the dashboard. Handy for a section picker. */
export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'Hero',
  text: 'Text',
  services: 'Services',
  steps: 'How it works',
  stats: 'Figures',
  testimonials: 'Testimonials',
  pricing: 'Pricing',
  faq: 'FAQ',
  cta: 'Call to action',
  contact: 'Contact',
};

/** Is this one of the section types the SDK has types for? */
export function isKnownSectionType(type: string): type is SectionType {
  return (SECTION_TYPES as readonly string[]).includes(type);
}
