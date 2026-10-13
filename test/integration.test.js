import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdGuardIntegration } from '../src/integration.js';
import { AdGuardError } from '../src/adguard/client.js';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

const CONFIG = { url: 'http://192.168.1.10:3000', username: 'admin', password: 'hunter2' };

function snapshot(overrides = {}) {
  return {
    version: 'v0.107.79',
    protection_enabled: true,
    protection_paused_until: null,
    safebrowsing_enabled: false,
    parental_enabled: false,
    safesearch_enabled: false,
    stats: {
      queries_24h: 30000,
      blocked_24h: 3000,
      blocked_percent: 10,
      avg_processing_ms: 44.14,
      hourly: [],
      top_blocked_domains: [],
      top_queried_domains: [],
      top_clients: [],
    },
    fetched_at: '2026-09-26T12:00:00.000Z',
    ...overrides,
  };
}

// A fake AdGuard client recording writes, and a scripted fetchSnapshot: each
// poll takes the next outcome (a snapshot, or an Error to throw); the last
// outcome repeats.
function setup({ outcomes = [snapshot()] } = {}) {
  const gladys = createFakeGladys({ selector: 'test' });
  const writes = [];
  const client = {
    setProtection: async (...args) => writes.push(['setProtection', ...args]),
    setSafeBrowsing: async (...args) => writes.push(['setSafeBrowsing', ...args]),
    setParental: async (...args) => writes.push(['setParental', ...args]),
    setSafeSearch: async (...args) => writes.push(['setSafeSearch', ...args]),
  };
  const createdClients = [];
  let polls = 0;
  const logs = { warn: [], error: [], info: [], debug: [] };
  const logger = Object.fromEntries(
    Object.keys(logs).map((level) => [level, (...args) => logs[level].push(args)]),
  );
  const timers = new Set();
  const integration = new AdGuardIntegration(gladys, {
    createClient: (config) => {
      createdClients.push(config);
      return client;
    },
    fetchSnapshot: async () => {
      const outcome = outcomes[Math.min(polls, outcomes.length - 1)];
      polls += 1;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return typeof outcome === 'function' ? outcome() : outcome;
    },
    logger,
    setTimer: () => {
      const id = Symbol('timer');
      timers.add(id);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return { gladys, integration, writes, createdClients, logs, timers, polls: () => polls };
}

// fake.states keeps the whole history: the states published from now on.
function statesFromNow(gladys) {
  const start = gladys.fake.states.length;
  return () => gladys.fake.states.slice(start);
}

// fake.discoveredDevices only keeps the last list: count the publications.
const discoveredPublications = (gladys) => gladys.fake.bodies('POST', '/discovered_device').length;

const unreachable = () =>
  new AdGuardError('unreachable', 'GET /control/status: AdGuard Home is unreachable', {
    code: 'ECONNREFUSED',
  });

test('without an address, Gladys is told what to fill in and nothing polls', async () => {
  const { gladys, integration, timers, polls } = setup();

  await integration.applyConfig({});

  assert.equal(polls(), 0);
  assert.equal(timers.size, 0);
  assert.equal(gladys.fake.connectionStatuses.length, 1);
  assert.equal(gladys.fake.connectionStatuses[0].connected, false);
  assert.match(gladys.fake.connectionStatuses[0].message.fr, /adresse/);
  await assert.rejects(integration.handleScan(), /address/);
  // The widgets still render something instead of failing the dashboard.
  assert.ok(integration.widgetOverview().components.length > 0);
});

test('an unusable address gets its own message, not "enter the address"', async () => {
  const { gladys, integration, polls } = setup();

  await integration.applyConfig({ url: 'http://admin:secret@192.168.1.10' });

  assert.equal(polls(), 0);
  assert.match(gladys.fake.connectionStatuses[0].message.fr, /n'est pas valide/);
});

test('the first poll reports the connection, publishes the device and every state', async () => {
  const { gladys, integration, createdClients, timers } = setup();

  await integration.applyConfig({ ...CONFIG, poll_frequency: '30' });

  assert.equal(createdClients[0].url, CONFIG.url);
  assert.deepEqual(gladys.fake.connectionStatuses, [{ connected: true }]);
  assert.equal(discoveredPublications(gladys), 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.states.length, 8);
  assert.equal(timers.size, 1, 'next poll scheduled');
});

test('a poll only publishes the states that changed', async () => {
  const { gladys, integration } = setup({
    outcomes: [snapshot(), snapshot(), snapshot({ protection_enabled: false })],
  });
  await integration.applyConfig(CONFIG);
  const published = statesFromNow(gladys);

  await integration.poll();
  assert.equal(published().length, 0);

  await integration.poll();
  assert.equal(published().length, 1);
  assert.equal(published()[0].state, 0);
  assert.equal(discoveredPublications(gladys), 1, 'the device is published once per config');
});

test('an outage is reported once, logged loudly once, and recovery is reported', async () => {
  const { gladys, integration, logs } = setup({
    outcomes: [snapshot(), unreachable(), unreachable(), snapshot()],
  });
  await integration.applyConfig(CONFIG);

  await integration.poll();
  await integration.poll();

  // fake.connectionStatuses is rebuilt on every read.
  let statuses = gladys.fake.connectionStatuses;
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1].connected, false);
  assert.match(statuses[1].message.fr, /injoignable/);
  assert.equal(logs.warn.length, 1);
  assert.deepEqual(integration.lastError, statuses[1].message);

  await integration.poll();
  statuses = gladys.fake.connectionStatuses;
  assert.equal(statuses.length, 3);
  assert.equal(statuses[2].connected, true);
  assert.equal(integration.lastError, null);
});

test('a refused password suspends polling so AdGuard does not lock Gladys out', async () => {
  const refused = new AdGuardError('auth', 'GET /control/status: authentication refused', {
    status: 401,
  });
  const { gladys, integration, timers, polls } = setup({ outcomes: [refused, snapshot()] });

  await integration.applyConfig(CONFIG);

  assert.equal(polls(), 1);
  assert.equal(timers.size, 0, 'no retry scheduled');
  assert.match(gladys.fake.connectionStatuses[0].message.fr, /suspendues/);

  // "Test the connection" after fixing the password resumes the loop.
  await integration.testConnection();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('AdGuard unreachable at boot: the loop keeps running and nothing is thrown', async () => {
  const { gladys, integration, timers } = setup({ outcomes: [unreachable()] });

  await integration.applyConfig(CONFIG);

  assert.equal(gladys.fake.connectionStatuses[0].connected, false);
  assert.equal(discoveredPublications(gladys), 0);
  assert.equal(timers.size, 1);
  // The widgets explain the situation rather than throwing.
  assert.ok(integration.widgetOverview().components.length > 0);
});

test('a Gladys-side failure is not mistaken for an AdGuard outage', async (t) => {
  const { gladys, integration, logs } = setup();
  // publishChangedStates goes through publishStates: one host API 429.
  t.mock.method(gladys, 'publishStates').mock.mockImplementationOnce(async () => {
    throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'RATE_LIMIT_EXCEEDED');
  });

  await integration.applyConfig(CONFIG);

  assert.equal(integration.lastError, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(logs.error.length, 1);
  assert.equal(gladys.fake.states.length, 0);
  // Nothing was recorded as published, so the next poll publishes it all.
  await integration.poll();
  assert.equal(gladys.fake.states.length, 8);
});

test('a poll that resolves after a config change publishes nothing', async () => {
  let release;
  const slow = () =>
    new Promise((resolve) => {
      release = () => resolve(snapshot({ protection_enabled: false }));
    });
  const { gladys, integration } = setup({ outcomes: [snapshot(), slow, snapshot()] });
  await integration.applyConfig(CONFIG);
  const published = statesFromNow(gladys);

  const stale = integration.poll();
  await integration.applyConfig({ ...CONFIG, url: 'http://192.168.1.11' });
  release();
  await stale;

  assert.ok(
    published().every(
      (state) => state.state !== 0 || !state.device_feature_external_id.endsWith(':protection'),
    ),
    'the stale "protection off" read was dropped',
  );
});

test('switching a feature writes to AdGuard, refreshes and nudges the overview widget', async () => {
  const { gladys, integration, writes } = setup({
    outcomes: [snapshot(), snapshot({ safebrowsing_enabled: true })],
  });
  // Widget refresh nudges go over the WebSocket: only sent once connected.
  await gladys.connect();
  await integration.applyConfig(CONFIG);
  const feature = gladys.fake.discoveredDevices[0].features.find((f) =>
    f.external_id.endsWith(':safebrowsing'),
  );

  await integration.handleSetValue({}, feature, 1);

  assert.deepEqual(writes, [['setSafeBrowsing', true]]);
  assert.deepEqual(gladys.fake.states.at(-1), {
    device_feature_external_id: feature.external_id,
    state: 1,
  });
  assert.deepEqual(gladys.fake.widgetRefreshes, ['overview']);
  await gladys.disconnect();
});

test('a switch command still shows its value when the refresh after it fails', async () => {
  const { gladys, integration, writes } = setup({ outcomes: [snapshot(), unreachable()] });
  await integration.applyConfig(CONFIG);
  const feature = gladys.fake.discoveredDevices[0].features.find((f) =>
    f.external_id.endsWith(':safebrowsing'),
  );
  const published = statesFromNow(gladys);

  await integration.handleSetValue({}, feature, 1);

  assert.deepEqual(writes, [['setSafeBrowsing', true]]);
  assert.notEqual(integration.lastError, null);
  assert.deepEqual(published(), [{ device_feature_external_id: feature.external_id, state: 1 }]);
});

test('a switch command on an unknown feature is refused', async () => {
  const { integration } = setup();
  await integration.applyConfig(CONFIG);

  await assert.rejects(integration.handleSetValue({}, { external_id: 'ext:test:nope' }, 1));
});

test('an AdGuard failure during a write becomes a readable bilingual error', async () => {
  const { integration } = setup();
  await integration.applyConfig(CONFIG);

  await assert.rejects(
    integration.write(async () => {
      throw unreachable();
    }),
    (err) => err.message.includes(' / ') && !err.message.includes('hunter2'),
  );
});

test('creating the device in Gladys republishes every state', async () => {
  const { gladys, integration } = setup();
  gladys.onDeviceCreated(() => integration.handleDeviceCreated());
  await integration.applyConfig(CONFIG);
  const published = statesFromNow(gladys);

  // The SDK forgets the device's published values before running the handler.
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);

  assert.equal(published().length, 8);
});

test('test_connection returns the version, or throws a readable error', async () => {
  const ok = setup();
  await ok.integration.applyConfig(CONFIG);
  assert.match((await ok.integration.testConnection()).fr, /v0\.107\.79/);

  const ko = setup({ outcomes: [unreachable()] });
  await ko.integration.applyConfig(CONFIG);
  await assert.rejects(ko.integration.testConnection(), / \/ /);

  const empty = setup();
  await empty.integration.applyConfig({});
  await assert.rejects(empty.integration.testConnection(), /address/);
});

test('stop leaves no timer behind', async () => {
  const { integration, timers } = setup();
  await integration.applyConfig(CONFIG);

  integration.stop();

  assert.equal(timers.size, 0);
});
