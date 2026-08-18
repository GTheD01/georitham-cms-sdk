/**
 * Getting at a section without writing the same `.find()` in every project.
 *
 * A page is an ordered list of sections, and a component wants one of them by
 * type. Doing that by index couples a template to the order an editor happens
 * to have dragged things into; doing it by `type` does not.
 */

import { CmsContentError } from './errors.js';
import type { AnySection, CmsLink, SectionOf, SectionType } from './sections.js';
import type { PageDetail } from './types.js';

type SectionSource = PageDetail | AnySection[] | { sections: AnySection[] };

function sectionsOf(source: SectionSource): AnySection[] {
  if (Array.isArray(source)) return source;
  return Array.isArray(source.sections) ? source.sections : [];
}

function describe(source: SectionSource): string {
  const types = sectionsOf(source).map((section) => section?.type);
  return types.length ? types.join(', ') : 'none';
}

/** Is this section of that type? Narrows, so the fields come with it. */
export function isSection<T extends SectionType>(
  section: AnySection | undefined,
  type: T,
): section is SectionOf<T> {
  return section?.type === type;
}

/** The first section of this type, or `undefined`. */
export function findSection<T extends SectionType>(
  source: SectionSource,
  type: T,
): SectionOf<T> | undefined {
  return sectionsOf(source).find((section) => section?.type === type) as
    | SectionOf<T>
    | undefined;
}

/** Every section of this type, in page order. */
export function sectionsOfType<T extends SectionType>(
  source: SectionSource,
  type: T,
): SectionOf<T>[] {
  return sectionsOf(source).filter((section) => section?.type === type) as SectionOf<T>[];
}

/**
 * The first section of this type, or a readable failure.
 *
 * Use it where the page cannot render without one. The message names what the
 * page *does* contain, which is almost always the answer: a typo in the slug,
 * or a section that was never added.
 */
export function requireSection<T extends SectionType>(
  source: SectionSource,
  type: T,
): SectionOf<T> {
  const section = findSection(source, type);
  if (!section) {
    throw new CmsContentError(
      `No “${type}” section on this page (it has: ${describe(source)}).`,
    );
  }
  return section;
}

/** An empty link, in the shape the API sends one. */
export const EMPTY_LINK: CmsLink = Object.freeze({ label: '', href: '' });

/**
 * A call to action worth rendering.
 *
 * A link with a label and nowhere to go is not filled in, it is half filled in
 * — and the missing half is the point of it.
 *
 * The types promise both fields; the wire does not, and a section type this SDK
 * has not learned yet arrives with `unknown` fields. So this asks rather than
 * assumes — a half-formed link is exactly the thing it exists to report on, and
 * throwing over one would be the wrong answer twice.
 */
export function isUsable(link: CmsLink | undefined | null): boolean {
  if (!link || typeof link !== 'object') return false;
  const { label, href } = link as { label?: unknown; href?: unknown };
  return (
    typeof label === 'string' &&
    label.trim() !== '' &&
    typeof href === 'string' &&
    href.trim() !== ''
  );
}
