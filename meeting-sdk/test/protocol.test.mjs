// Wrapper <-> native helper handshake. Needs the helper built: native/macos/build.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('../packages/sdk');
const darwin = process.platform === 'darwin';

test('init, events, diagnostics and shutdown', { skip: !darwin }, async () => {
  const events = [];
  sdk.addEventListener('permission-status', (e) => events.push(e));
  sdk.addEventListener('shutdown', (e) => events.push({ shutdown: e }));

  assert.equal(await sdk.init({ apiUrl: 'https://api.example.com' }), null);

  // Reference behaviour (re/notes/trace-startup.jsonl): all eight permissions are reported during init,
  // before the init response, in this order.
  assert.deepEqual(
    events.filter((e) => e.permission).map((e) => e.permission),
    ['accessibility', 'microphone', 'screen-capture', 'system-audio', 'full-disk-access',
      'teams-automation', 'browser-automation', 'zoom-raw-media'],
  );
  const unrequested = events.find((e) => e.permission === 'zoom-raw-media');
  assert.deepEqual({ granted: unrequested.granted, status: unrequested.status }, { granted: false, status: 'not_requested' });

  // system-audio has no prompt in this helper yet, so requesting it just reports the status again.
  await sdk.requestPermission('system-audio');

  const apps = await sdk.dumpAllApplications();
  assert.ok(Array.isArray(apps) && apps.length > 0);
  assert.ok(apps.some((a) => a.bundleId === 'com.apple.finder'));

  // Regression: without a window-server connection this call aborts the helper (seen when recording a window).
  assert.ok(await sdk._debug('debugDisplays', {}) >= 0);

  await assert.rejects(sdk.dumpAXTree('no-such-process-xyz'), /No running process/);
  await assert.rejects(sdk.listDevices(), /only available on Windows/);

  await sdk.shutdown();
  assert.ok(events.some((e) => e.shutdown && e.shutdown.code === 0));
  await assert.rejects(sdk.requestPermission('microphone'), /not started/);
});

test('init rejects non-https api urls unless dev', async () => {
  await assert.rejects(sdk.init({ apiUrl: 'http://x.example' }), /https/);
  await assert.rejects(sdk.init({ telemetryMode: 'bogus' }), /telemetryMode/);
});
