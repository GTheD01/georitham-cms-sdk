/**
 * The watcher, which is a long-lived process by definition — so the failures
 * that matter are the ones that never end: a loop that will not stop, and a
 * publish that is marked seen without ever being acted on.
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createClient, watchContent } from 'georitham-cms-sdk';

import { startCms } from './support/server.mjs';

async function withCms(options, body) {
  const cms = await startCms(options);
  try {
    return await body(cms, createClient({ origin: cms.origin, site: cms.site }));
  } finally {
    await cms.close();
  }
}

test('a signal that has already aborted never starts a watcher', async () => {
  // `addEventListener('abort')` on an aborted signal never fires, so a watcher
  // built on that alone polls for the life of the process.
  await withCms({}, async (server, client) => {
    const stop = watchContent(client, { signal: AbortSignal.abort(), intervalMs: 1000 }, () => {
      assert.fail('the handler must never run');
    });

    await delay(60);
    stop();

    assert.deepEqual(server.requests(), []);
  });
});

test('a publish is not marked seen until the handler has dealt with it', async () => {
  await withCms({}, async (server, client) => {
    const attempts = [];

    const stop = watchContent(
      client,
      { since: 12, intervalMs: 1000, immediate: false, onError: () => {} },
      (manifest) => {
        attempts.push(manifest.contentVersion);
        // Fails the first time, the way a deploy hook does when it is briefly
        // unavailable. The publish must not be lost with it.
        if (attempts.length === 1) throw new Error('deploy hook is down');
      },
    );

    server.publish();
    await delay(1300);
    await delay(1300);
    stop();

    // Called again with the same version, rather than the publish vanishing.
    assert.deepEqual(attempts, [13, 13]);
  });
});

test('the first poll sets a baseline instead of reporting a publish', async () => {
  await withCms({}, async (_server, client) => {
    let called = 0;
    const stop = watchContent(client, { intervalMs: 1000 }, () => {
      called += 1;
    });

    await delay(100);
    stop();

    assert.equal(called, 0);
  });
});

test('stopping is enough to end it, and a stopped watcher stays stopped', async () => {
  await withCms({}, async (server, client) => {
    const stop = watchContent(client, { intervalMs: 1000 }, () => {});

    await delay(100);
    stop();
    const after = server.requests().length;

    await delay(1300);
    assert.equal(server.requests().length, after);
  });
});
