/**
 * The signature tests are built on a fixture the **CMS** produced — its own
 * `serialize()` for the body and its own `sign()` for the signature. Verifying
 * against a signature this package generated would only prove it agrees with
 * itself; verifying against Django's proves the two implementations are the
 * same one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseWebhookEvent, signWebhook, verifyWebhook } from 'georitham-cms-sdk/webhooks';

const fixture = JSON.parse(
  readFileSync(new URL('./support/webhook-fixture.json', import.meta.url), 'utf8'),
);

/** The fixture's timestamp, so the replay window is not a moving target. */
const atTheTime = () => Number(fixture.timestamp) * 1000;

function headers(overrides = {}) {
  return {
    'x-georitham-signature': fixture.signature,
    'x-georitham-timestamp': fixture.timestamp,
    'x-georitham-event': 'page.published',
    'x-georitham-delivery': '4291',
    ...overrides,
  };
}

test('a delivery signed by the CMS verifies, and arrives typed', async () => {
  const event = await verifyWebhook({
    body: fixture.body,
    headers: headers(),
    secret: fixture.secret,
    now: atTheTime,
  });

  assert.equal(event.event, 'page.published');
  assert.equal(event.site, 'georitham');
  assert.equal(event.contentVersion, 12);
  assert.equal(event.delivery, '4291');
  assert.deepEqual(event.page, {
    id: 7,
    slug: 'landing-page',
    locale: 'de',
    title: 'Startseite',
    status: 'published',
    urlPath: '/landing-page',
  });
  assert.deepEqual(event.version, { number: 3, publishedAt: '2026-08-18T09:15:00+00:00' });
  // Anything not modelled above is still reachable.
  assert.equal(event.raw.page.url_path, '/landing-page');
});

test('signing reproduces the CMS byte for byte', async () => {
  const signature = await signWebhook({
    body: fixture.body,
    timestamp: fixture.timestamp,
    secret: fixture.secret,
  });

  assert.equal(signature, fixture.signature);
});

test('the wrong secret is refused', async () => {
  await assert.rejects(
    verifyWebhook({
      body: fixture.body,
      headers: headers(),
      secret: `${fixture.secret}0`,
      now: atTheTime,
    }),
    /Signature does not match/,
  );
});

test('a tampered body is refused', async () => {
  const tampered = fixture.body.replace('"content_version":12', '"content_version":99');

  await assert.rejects(
    verifyWebhook({ body: tampered, headers: headers(), secret: fixture.secret, now: atTheTime }),
    /Signature does not match/,
  );
});

test('a captured delivery replayed later is refused, signature and all', async () => {
  await assert.rejects(
    verifyWebhook({
      body: fixture.body,
      headers: headers(),
      secret: fixture.secret,
      now: () => atTheTime() + 3600_000,
    }),
    /outside the 300s window/,
  );

  // The signature itself is still perfectly valid — only the clock refuses it.
  const accepted = await verifyWebhook({
    body: fixture.body,
    headers: headers(),
    secret: fixture.secret,
    now: () => atTheTime() + 3600_000,
    toleranceSeconds: 0,
  });
  assert.equal(accepted.event, 'page.published');
});

test('a missing header is refused rather than ignored', async () => {
  await assert.rejects(
    verifyWebhook({
      body: fixture.body,
      headers: headers({ 'x-georitham-signature': undefined }),
      secret: fixture.secret,
      now: atTheTime,
    }),
    /Missing x-georitham-signature/,
  );

  await assert.rejects(
    verifyWebhook({ body: fixture.body, headers: headers(), secret: '', now: atTheTime }),
    /No signing secret/,
  );
});

test('a signature that is not hex, or the wrong length, is refused', async () => {
  for (const signature of ['sha256=zzzz', 'sha256=', 'sha256=abc', fixture.signature.slice(7)]) {
    await assert.rejects(
      verifyWebhook({
        body: fixture.body,
        headers: headers({ 'x-georitham-signature': signature }),
        secret: fixture.secret,
        now: atTheTime,
      }),
      /Signature does not match/,
      `should refuse ${signature}`,
    );
  }
});

test('headers arrive in three shapes, and all three work', async () => {
  const shapes = [
    headers(),
    new Headers(headers()),
    // Node's own IncomingHttpHeaders, where a repeated header is an array.
    { ...headers(), 'x-georitham-signature': [fixture.signature] },
    // Casing is not something a receiver should have to care about.
    { 'X-Georitham-Signature': fixture.signature, 'X-Georitham-Timestamp': fixture.timestamp },
  ];

  for (const shape of shapes) {
    const event = await verifyWebhook({
      body: fixture.body,
      headers: shape,
      secret: fixture.secret,
      now: atTheTime,
    });
    assert.equal(event.site, 'georitham');
  }
});

test('an event without a version parses — deletions have none', () => {
  const event = parseWebhookEvent(
    JSON.stringify({
      event: 'page.deleted',
      site: 'georitham',
      page: { id: 7, slug: 'gone', locale: 'de', title: 'Weg', status: 'draft', url_path: '/gone' },
      content_version: 13,
    }),
  );

  assert.equal(event.event, 'page.deleted');
  assert.equal(event.version, null);
  assert.equal(event.delivery, null);
});

test('a body that is not JSON fails as a verification problem, not a crash', () => {
  assert.throws(() => parseWebhookEvent('not json'), /not JSON/);
});

test('a body that is JSON but not a delivery is refused, not a crash', async () => {
  // `JSON.parse('null')` succeeds. Dereferencing it does not — and a raw
  // TypeError makes a receiver answer 500, which the CMS retries five times.
  for (const body of ['null', '123', '"a string"', 'true', '[]', '[{"event": "x"}]']) {
    assert.throws(
      () => parseWebhookEvent(body),
      (error) => {
        assert.equal(error.code, 'webhook');
        assert.equal(error.name, 'WebhookVerificationError');
        return true;
      },
      `expected ${body} to be refused`,
    );
  }
});

test('a delivery with the wrong shape inside it parses to empties, not NaN', async () => {
  const event = parseWebhookEvent('{"event": "page.published", "page": "x", "version": "y"}');

  assert.equal(event.event, 'page.published');
  assert.equal(event.page.id, 0);
  assert.equal(event.page.slug, '');
  assert.equal(event.version, null);
});

test('a timestamp that is not a number says so, rather than counting NaN seconds', async () => {
  const body = JSON.stringify({ event: 'page.published' });
  const secret = 'shhh';
  const signature = await signWebhook({ body, timestamp: 'not-a-number', secret });

  await assert.rejects(
    verifyWebhook({
      body,
      secret,
      headers: {
        'x-georitham-signature': signature,
        'x-georitham-timestamp': 'not-a-number',
      },
    }),
    (error) => {
      assert.equal(error.code, 'webhook');
      assert.match(error.message, /not a number of seconds/);
      return true;
    },
  );
});
