import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_LINK,
  findSection,
  isKnownSectionType,
  isSection,
  isUsable,
  requireSection,
  SECTION_LABELS,
  SECTION_TYPES,
  sectionsOfType,
} from 'georitham-cms-sdk';

import { SECTIONS } from './support/server.mjs';

const page = {
  slug: 'landing-page',
  locale: 'de',
  sections: [SECTIONS.hero, SECTIONS.faq, { ...SECTIONS.faq, heading: 'Mehr Fragen' }],
};

test('a section is found by type, not by position', () => {
  assert.equal(findSection(page, 'hero').headingLead, 'Technologie, die');
  assert.equal(findSection(page, 'faq').heading, 'Fragen');
  assert.equal(findSection(page, 'pricing'), undefined);

  // A bare array of sections works as well as a page.
  assert.equal(findSection(page.sections, 'hero').type, 'hero');
  assert.equal(findSection({ sections: [] }, 'hero'), undefined);
});

test('every section of a type comes back in page order', () => {
  const faqs = sectionsOfType(page, 'faq');

  assert.equal(faqs.length, 2);
  assert.deepEqual(
    faqs.map((section) => section.heading),
    ['Fragen', 'Mehr Fragen'],
  );
});

test('requireSection names what the page does contain', () => {
  assert.equal(requireSection(page, 'hero').type, 'hero');

  assert.throws(() => requireSection(page, 'pricing'), (error) => {
    assert.equal(error.code, 'content');
    assert.match(error.message, /No “pricing” section on this page \(it has: hero, faq, faq\)/);
    return true;
  });

  assert.throws(() => requireSection({ sections: [] }, 'hero'), /it has: none/);
});

test('isSection narrows a single section', () => {
  assert.equal(isSection(page.sections[0], 'hero'), true);
  assert.equal(isSection(page.sections[0], 'faq'), false);
  assert.equal(isSection(undefined, 'hero'), false);
});

test('a call to action needs somewhere to go', () => {
  assert.equal(isUsable({ label: 'Erstgespräch', href: '#contact' }), true);
  assert.equal(isUsable({ label: 'Erstgespräch', href: '' }), false, 'no target');
  assert.equal(isUsable({ label: '   ', href: '#contact' }), false, 'no label');
  assert.equal(isUsable(EMPTY_LINK), false);
  assert.equal(isUsable(undefined), false);
});

test('an unknown section type is data, not a crash', () => {
  const future = { sections: [{ type: 'gallery', images: [] }] };

  assert.equal(findSection(future, 'hero'), undefined);
  assert.equal(isKnownSectionType('gallery'), false);
  assert.equal(isKnownSectionType('hero'), true);
  assert.throws(() => requireSection(future, 'hero'), /it has: gallery/);
});

test('every declared type has a label', () => {
  assert.equal(SECTION_TYPES.length, 10);
  for (const type of SECTION_TYPES) {
    assert.equal(typeof SECTION_LABELS[type], 'string', `${type} needs a label`);
  }
});

test('a half-formed link is not usable, and does not throw on the way to saying so', async () => {
  // The types promise both fields; an unknown section type carries `unknown`
  // ones, and `isUsable` exists precisely to report on links like these.
  assert.equal(isUsable({ href: '#contact' }), false);
  assert.equal(isUsable({ label: 'Talk to us' }), false);
  assert.equal(isUsable({ label: 42, href: '#contact' }), false);
  assert.equal(isUsable({ label: 'Talk to us', href: null }), false);
  assert.equal(isUsable({}), false);
  assert.equal(isUsable('#contact'), false);
  assert.equal(isUsable(null), false);
});
