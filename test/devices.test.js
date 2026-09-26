import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GladysIntegration,
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  applySetValue,
  buildDevice,
  buildStates,
  featureKeyOf,
} from '../src/devices.js';

const SELECTOR = 'adguard-home';

// The real SDK client: its constructor does not connect, so externalIds()
// is the exact production format.
const gladys = new GladysIntegration({
  hostApiUrl: 'http://127.0.0.1:1',
  token: 'dummy-token',
  selector: SELECTOR,
  logger: createLogger({ level: 'silent' }),
});

const PREFIX = `ext:${SELECTOR}:`;
const CATEGORIES = Object.values(DEVICE_FEATURE_CATEGORIES);
const TYPES = new Set(Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group)));
const UNITS = Object.values(DEVICE_FEATURE_UNITS);

/**
 * Mirror of the checks the Gladys core runs on POST /discovered_device
 * (externalIntegration.setDiscoveredDevices), plus the NOT NULL min/max of the
 * device_feature model.
 */
function validateDiscoveredDevice(device) {
  assert.equal(typeof device.name, 'string');
  assert.ok(device.name.length > 0);
  assert.ok(device.external_id.startsWith(PREFIX));
  assert.ok(Array.isArray(device.features));
  for (const feature of device.features) {
    assert.ok(feature.external_id.startsWith(PREFIX), feature.external_id);
    assert.ok(CATEGORIES.includes(feature.category), `${feature.external_id}: ${feature.category}`);
    assert.ok(TYPES.has(feature.type), `${feature.external_id}: ${feature.type}`);
    if (feature.unit !== undefined) {
      assert.ok(UNITS.includes(feature.unit), `${feature.external_id}: ${feature.unit}`);
    }
    assert.equal(typeof feature.name, 'string');
    assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max));
    assert.ok(feature.min < feature.max);
    assert.equal(typeof feature.read_only, 'boolean');
    assert.equal(typeof feature.has_feedback, 'boolean');
    assert.equal(typeof feature.keep_history, 'boolean');
    assert.equal('selector' in feature, false);
  }
  for (const param of device.params ?? []) {
    assert.equal(typeof param.name, 'string');
    assert.equal(typeof param.value, 'string');
    assert.ok(!param.name.toUpperCase().startsWith('GLADYS_'));
  }
}

const snapshot = () => ({
  version: 'v0.107.79',
  protection_enabled: true,
  protection_paused_until: null,
  safebrowsing_enabled: false,
  parental_enabled: true,
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
  fetched_at: '2026-09-26T14:37:12.000Z',
});

/** AdGuardClient double recording the write calls. */
function fakeClient() {
  const calls = [];
  const record =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    setProtection: record('setProtection'),
    setSafeBrowsing: record('setSafeBrowsing'),
    setParental: record('setParental'),
    setSafeSearch: record('setSafeSearch'),
  };
}

test('buildDevice publishes a device the Gladys core accepts', () => {
  const device = buildDevice(gladys, { url: 'http://192.168.1.10:3000' });

  validateDiscoveredDevice(device);
  assert.equal(device.name, 'AdGuard Home');
  assert.deepEqual(device.params, [{ name: 'ADGUARD_URL', value: 'http://192.168.1.10:3000' }]);
  assert.deepEqual(
    device.features.map((feature) => feature.external_id),
    Object.values(FEATURE_KEYS).map((key) => `ext:${SELECTOR}:adguard-home:main:${key}`),
  );
});

test('buildDevice external ids are stable and independent of the URL', () => {
  const byIp = buildDevice(gladys, { url: 'http://192.168.1.10:3000' });
  const byName = buildDevice(gladys, { url: 'https://adguard.home.lan' });

  assert.equal(byIp.external_id, `ext:${SELECTOR}:adguard-home:main`);
  assert.equal(byName.external_id, byIp.external_id);
  assert.deepEqual(
    byName.features.map((feature) => feature.external_id),
    byIp.features.map((feature) => feature.external_id),
  );
});

test('buildDevice feature categories: switches, counters, percent, duration', () => {
  const byKey = Object.fromEntries(
    buildDevice(gladys, { url: 'http://x' }).features.map((feature) => [
      feature.external_id.split(':').at(-1),
      feature,
    ]),
  );

  for (const key of ['protection', 'safebrowsing', 'parental', 'safesearch']) {
    assert.equal(byKey[key].category, DEVICE_FEATURE_CATEGORIES.SWITCH);
    assert.equal(byKey[key].type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
    assert.equal(byKey[key].read_only, false);
    assert.equal(byKey[key].has_feedback, true);
    assert.deepEqual([byKey[key].min, byKey[key].max], [0, 1]);
  }
  for (const key of ['queries_24h', 'blocked_24h']) {
    assert.equal(byKey[key].category, DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR);
    assert.equal(byKey[key].type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
  }
  assert.equal(byKey.blocked_percent.unit, DEVICE_FEATURE_UNITS.PERCENT);
  assert.deepEqual([byKey.blocked_percent.min, byKey.blocked_percent.max], [0, 100]);
  assert.equal(byKey.avg_processing_time.category, DEVICE_FEATURE_CATEGORIES.DURATION);
  assert.equal(byKey.avg_processing_time.type, DEVICE_FEATURE_TYPES.DURATION.DECIMAL);
  assert.equal(byKey.avg_processing_time.unit, DEVICE_FEATURE_UNITS.MILLISECONDS);
  for (const key of ['queries_24h', 'blocked_24h', 'blocked_percent', 'avg_processing_time']) {
    assert.equal(byKey[key].read_only, true);
  }
  assert.ok(Object.values(byKey).every((feature) => feature.keep_history === true));
});

test('buildStates maps the snapshot to one numeric state per feature', () => {
  const ids = gladys.externalIds('adguard-home', 'main');
  const states = buildStates(gladys, snapshot());

  assert.deepEqual(states, [
    { device_feature_external_id: ids.feature('protection'), state: 1 },
    { device_feature_external_id: ids.feature('safebrowsing'), state: 0 },
    { device_feature_external_id: ids.feature('parental'), state: 1 },
    { device_feature_external_id: ids.feature('safesearch'), state: 0 },
    { device_feature_external_id: ids.feature('queries_24h'), state: 30000 },
    { device_feature_external_id: ids.feature('blocked_24h'), state: 3000 },
    { device_feature_external_id: ids.feature('blocked_percent'), state: 10 },
    { device_feature_external_id: ids.feature('avg_processing_time'), state: 44.14 },
  ]);
});

test('featureKeyOf finds our keys and rejects foreign ids', () => {
  const ids = gladys.externalIds('adguard-home', 'main');
  for (const key of Object.values(FEATURE_KEYS)) {
    assert.equal(featureKeyOf(gladys, ids.feature(key)), key);
  }
  assert.equal(featureKeyOf(gladys, ids.device), null);
  assert.equal(featureKeyOf(gladys, ids.feature('unknown')), null);
  assert.equal(featureKeyOf(gladys, `ext:other:adguard-home:main:protection`), null);
  assert.equal(featureKeyOf(gladys, undefined), null);
});

test('applySetValue dispatches each switch to its client method', async () => {
  const client = fakeClient();
  await applySetValue(client, 'protection', 0);
  await applySetValue(client, 'protection', 1);
  await applySetValue(client, 'safebrowsing', '1');
  await applySetValue(client, 'parental', true);
  await applySetValue(client, 'safesearch', 0);

  assert.deepEqual(client.calls, [
    ['setProtection', false],
    ['setProtection', true],
    ['setSafeBrowsing', true],
    ['setParental', true],
    ['setSafeSearch', false],
  ]);
});

test('applySetValue rejects unknown or read-only keys and values other than 0/1', async () => {
  const client = fakeClient();
  await assert.rejects(applySetValue(client, 'nope', 1), /Unknown feature/);
  await assert.rejects(applySetValue(client, 'queries_24h', 1), /read-only/);
  await assert.rejects(applySetValue(client, 'avg_processing_time', 0), /read-only/);
  for (const value of [2, -1, 0.5, 'on', null, undefined, '', NaN]) {
    await assert.rejects(applySetValue(client, 'protection', value), /expected 0 or 1/);
  }
  assert.deepEqual(client.calls, []);
});

test('applySetValue propagates the client error', async () => {
  const failure = new Error('refused');
  const client = {
    setParental: async () => {
      throw failure;
    },
  };
  await assert.rejects(applySetValue(client, 'parental', 1), failure);
});
