import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fixtures from './fixtures/adguard.js';
import {
  BLOCKED_SERVICES_KEY,
  PAUSE_DURATIONS_MS,
  PAUSE_PROTECTION_KEY,
  SERVICE_IDS,
  runBlockedServices,
  runPauseProtection,
} from '../src/scene-actions.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const sceneAction = (key) => manifest.scene_actions.find((action) => action.key === key);
const field = (action, key) => sceneAction(action).fields.find((f) => f.key === key);

// Fake AdGuardClient (methods of CONTRACTS.md) recording the write calls.
function fakeClient({ blocked = fixtures.blockedServices(), clients = fixtures.clients() } = {}) {
  const calls = [];
  return {
    calls,
    async setProtection(...args) {
      calls.push(['setProtection', ...args]);
    },
    async getBlockedServices() {
      return structuredClone(blocked);
    },
    async setBlockedServices(body) {
      calls.push(['setBlockedServices', body]);
    },
    async getClients() {
      return structuredClone(clients);
    },
    async updateClient(name, data) {
      calls.push(['updateClient', name, data]);
    },
  };
}

test('scene action keys match the manifest', () => {
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key),
    [PAUSE_PROTECTION_KEY, BLOCKED_SERVICES_KEY],
  );
});

test('SERVICE_IDS is exactly the manifest services options, same order', () => {
  assert.deepEqual(
    field(BLOCKED_SERVICES_KEY, 'services').options.map((option) => option.value),
    SERVICE_IDS,
  );
});

test('PAUSE_DURATIONS_MS is exactly the manifest duration options, same order', () => {
  const duration = field(PAUSE_PROTECTION_KEY, 'duration');
  assert.deepEqual(
    duration.options.map((option) => option.value),
    PAUSE_DURATIONS_MS.map(String),
  );
  assert.ok(PAUSE_DURATIONS_MS.includes(Number(duration.default)));
});

test('runPauseProtection pauses for the chosen duration and returns when it resumes', async () => {
  const client = fakeClient();
  const now = new Date('2026-09-26T14:20:00.000Z');
  const outputs = await runPauseProtection(
    client,
    { duration: '3600000' },
    { now, timeZone: 'Europe/Paris' },
  );
  assert.deepEqual(client.calls, [['setProtection', false, 3600000]]);
  // 15:20 UTC is 17:20 in Paris (summer time).
  assert.deepEqual(outputs, {
    resume_at: '2026-09-26T17:20:00+02:00',
    resume_time: '17:20',
  });
});

test('the pause_protection outputs are exactly the ones the manifest declares', async () => {
  const action = manifest.scene_actions.find((entry) => entry.key === PAUSE_PROTECTION_KEY);
  const outputs = await runPauseProtection(fakeClient(), { duration: '30000' });
  assert.deepEqual(action.outputs.map((output) => output.key).sort(), Object.keys(outputs).sort());
});

test('runPauseProtection rejects a duration outside the manifest options', async () => {
  const client = fakeClient();
  for (const duration of [undefined, '', '1000', '600000.5', 'abc', null]) {
    await assert.rejects(runPauseProtection(client, { duration }), /Invalid pause duration/);
  }
  await assert.rejects(runPauseProtection(client, undefined), /Invalid pause duration/);
  assert.deepEqual(client.calls, []);
});

test('blocked_services global block: merged, deduplicated, foreign ids and schedule kept', async () => {
  const schedule = { time_zone: 'Europe/Paris', mon: { start: 0, end: 3600000 } };
  const client = fakeClient({ blocked: { schedule, ids: ['9gag', 'tiktok'] } });
  const outputs = await runBlockedServices(client, {
    mode: 'block',
    services: ['tiktok', 'youtube', 'youtube'],
    client: '   ',
  });
  assert.deepEqual(client.calls, [
    ['setBlockedServices', { ids: ['9gag', 'tiktok', 'youtube'], schedule }],
  ]);
  assert.deepEqual(outputs, { blocked_services: '9gag, tiktok, youtube' });
});

test('blocked_services global unblock, services as a comma-separated string', async () => {
  const schedule = { time_zone: 'UTC' };
  const client = fakeClient({ blocked: { schedule, ids: ['9gag', 'tiktok', 'youtube'] } });
  const outputs = await runBlockedServices(client, {
    mode: 'unblock',
    services: ' tiktok, youtube ,',
  });
  assert.deepEqual(client.calls, [['setBlockedServices', { ids: ['9gag'], schedule }]]);
  assert.deepEqual(outputs, { blocked_services: '9gag' });
});

test('blocked_services unblocking everything returns an empty string', async () => {
  const client = fakeClient({ blocked: { schedule: {}, ids: ['tiktok'] } });
  const outputs = await runBlockedServices(client, { mode: 'unblock', services: ['tiktok'] });
  assert.deepEqual(outputs, { blocked_services: '' });
});

test('blocked_services per client matched by name (case-insensitive), starting from the global list', async () => {
  const client = fakeClient({ blocked: { schedule: {}, ids: ['reddit'] } });
  const outputs = await runBlockedServices(client, {
    mode: 'block',
    services: ['tiktok'],
    client: ' kids TABLET ',
  });
  const original = fixtures.clients().clients[1];
  assert.deepEqual(client.calls, [
    [
      'updateClient',
      'Kids tablet',
      { ...original, use_global_blocked_services: false, blocked_services: ['reddit', 'tiktok'] },
    ],
  ]);
  assert.deepEqual(outputs, { blocked_services: 'reddit, tiktok' });
});

test('blocked_services per client matched by IP, starting from its own list', async () => {
  const clients = fixtures.clients();
  clients.clients[2].use_global_blocked_services = false;
  clients.clients[2].blocked_services = ['netflix', 'youtube'];
  const client = fakeClient({ clients, blocked: { schedule: {}, ids: ['reddit'] } });
  const outputs = await runBlockedServices(client, {
    mode: 'unblock',
    services: ['youtube'],
    client: '192.168.1.175',
  });
  const [call] = client.calls;
  assert.equal(call[0], 'updateClient');
  assert.equal(call[1], 'Phone');
  assert.deepEqual(call[2].blocked_services, ['netflix']);
  assert.equal(call[2].use_global_blocked_services, false);
  assert.deepEqual(call[2].ids, ['192.168.1.175']);
  assert.deepEqual(outputs, { blocked_services: 'netflix' });
});

test('blocked_services rejects a client that is not persistent', async () => {
  const client = fakeClient();
  // printer.lan is only an auto (runtime) client.
  for (const target of ['printer.lan', '192.168.1.200', 'nobody']) {
    await assert.rejects(
      runBlockedServices(client, { mode: 'block', services: ['tiktok'], client: target }),
      /Only persistent clients \(configured in AdGuard Home > Settings > Client settings\)/,
    );
  }
  assert.deepEqual(client.calls, []);
});

test('blocked_services validates mode and services before calling AdGuard', async () => {
  const client = fakeClient();
  await assert.rejects(
    runBlockedServices(client, { mode: 'toggle', services: ['tiktok'] }),
    /mode/,
  );
  await assert.rejects(runBlockedServices(client, { services: ['tiktok'] }), /mode/);
  await assert.rejects(runBlockedServices(client, { mode: 'block', services: [] }), /No service/);
  await assert.rejects(
    runBlockedServices(client, { mode: 'block', services: ' , ' }),
    /No service/,
  );
  await assert.rejects(runBlockedServices(client, { mode: 'block' }), /No service/);
  await assert.rejects(
    runBlockedServices(client, { mode: 'block', services: ['tiktok', '9gag'] }),
    /Unknown service id\(s\): 9gag/,
  );
  await assert.rejects(runBlockedServices(client, undefined), /mode/);
  assert.deepEqual(client.calls, []);
});
