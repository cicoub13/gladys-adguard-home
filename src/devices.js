// -----------------------------------------------------------------------------
// Mapping between an AdGuard Home instance and ONE Gladys device.
//
// A Gladys integration instance talks to a single AdGuard Home, so the device
// external ids are constants: they are never derived from the configured URL,
// otherwise switching the address from an IP to a hostname would orphan the
// device (and its history) in Gladys. AdGuard Home exposes no stable instance
// id to use instead.
//
// Features:
//   - 4 switches (switch/binary): protection, safe browsing, parental control,
//     safe search — writable, the poller publishes the real state back;
//   - 24 h query and block counts (counter-sensor/integer, the category Gladys
//     uses for event counts, e.g. Tasmota counters);
//   - blocked ratio (counter-sensor/integer, percent, rounded): Gladys has no
//     generic percentage category, and its front only labels and icons the
//     integer type of counter-sensor (the overview widget keeps the decimal);
//   - average processing time (duration/decimal, milliseconds).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'adguard-home';
export const PLATFORM_ID = 'main';
export const DEVICE_NAME = 'AdGuard Home';
export const URL_PARAM = 'ADGUARD_URL';

// Feature keys (suffix of the feature external_id). Stable: renaming one
// orphans the feature in Gladys.
export const FEATURE_KEYS = Object.freeze({
  PROTECTION: 'protection',
  SAFEBROWSING: 'safebrowsing',
  PARENTAL: 'parental',
  SAFESEARCH: 'safesearch',
  QUERIES_24H: 'queries_24h',
  BLOCKED_24H: 'blocked_24h',
  BLOCKED_PERCENT: 'blocked_percent',
  AVG_PROCESSING_TIME: 'avg_processing_time',
});

const COUNTER_MAX = 100_000_000;

const switchFeature = (key, name, snapshotField, write) => ({
  key,
  definition: {
    name,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  value: (snapshot) => (snapshot[snapshotField] ? 1 : 0),
  write,
});

const sensorFeature = (key, definition, value) => ({
  key,
  definition: { ...definition, read_only: true, has_feedback: false, keep_history: true },
  value,
});

// Order = display order in Gladys.
const FEATURES = [
  switchFeature(FEATURE_KEYS.PROTECTION, 'DNS protection', 'protection_enabled', (client, on) =>
    client.setProtection(on),
  ),
  switchFeature(FEATURE_KEYS.SAFEBROWSING, 'Safe browsing', 'safebrowsing_enabled', (client, on) =>
    client.setSafeBrowsing(on),
  ),
  switchFeature(FEATURE_KEYS.PARENTAL, 'Parental control', 'parental_enabled', (client, on) =>
    client.setParental(on),
  ),
  switchFeature(FEATURE_KEYS.SAFESEARCH, 'Safe search', 'safesearch_enabled', (client, on) =>
    client.setSafeSearch(on),
  ),
  sensorFeature(
    FEATURE_KEYS.QUERIES_24H,
    {
      name: 'DNS queries (24 h)',
      category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: COUNTER_MAX,
    },
    (snapshot) => snapshot.stats.queries_24h,
  ),
  sensorFeature(
    FEATURE_KEYS.BLOCKED_24H,
    {
      name: 'Blocked queries (24 h)',
      category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: COUNTER_MAX,
    },
    (snapshot) => snapshot.stats.blocked_24h,
  ),
  sensorFeature(
    FEATURE_KEYS.BLOCKED_PERCENT,
    {
      name: 'Blocked queries ratio (24 h)',
      category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
    },
    (snapshot) => Math.round(snapshot.stats.blocked_percent),
  ),
  sensorFeature(
    FEATURE_KEYS.AVG_PROCESSING_TIME,
    {
      name: 'Average processing time',
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.MILLISECONDS,
      min: 0,
      max: 60_000,
    },
    (snapshot) => snapshot.stats.avg_processing_ms,
  ),
];

const FEATURES_BY_KEY = new Map(FEATURES.map((feature) => [feature.key, feature]));

const idsOf = (gladys) => gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);

/**
 * Build the discovery payload of the AdGuard Home device.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {{url: string}} config - Normalized configuration (only the URL is published).
 * @returns {object} Device for publishDiscoveredDevices.
 * @example
 * await gladys.publishDiscoveredDevices([buildDevice(gladys, config)]);
 */
export function buildDevice(gladys, { url }) {
  const ids = idsOf(gladys);
  return {
    name: DEVICE_NAME,
    external_id: ids.device,
    params: [{ name: URL_PARAM, value: url }],
    features: FEATURES.map(({ key, definition }) => ({
      ...definition,
      external_id: ids.feature(key),
    })),
  };
}

/**
 * Translate a snapshot into the feature states of the device.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {object} snapshot - Result of fetchSnapshot.
 * @returns {Array<{device_feature_external_id: string, state: number}>} One state per feature.
 * @example
 * await gladys.publishStates(buildStates(gladys, snapshot));
 */
export function buildStates(gladys, snapshot) {
  const ids = idsOf(gladys);
  return FEATURES.map(({ key, value }) => ({
    device_feature_external_id: ids.feature(key),
    state: value(snapshot),
  }));
}

/**
 * Find the feature key of a feature external id of this device.
 * @param {{externalIds: Function}} gladys - The SDK client.
 * @param {string} featureExternalId - External id received from Gladys.
 * @returns {string|null} One of FEATURE_KEYS, or null when it is not ours.
 * @example
 * featureKeyOf(gladys, feature.external_id); // 'protection'
 */
export function featureKeyOf(gladys, featureExternalId) {
  const ids = idsOf(gladys);
  const feature = FEATURES.find(({ key }) => ids.feature(key) === featureExternalId);
  return feature ? feature.key : null;
}

/**
 * Apply a value set from Gladys on a writable feature.
 * @param {import('./adguard/client.js').AdGuardClient} client - The AdGuard Home client.
 * @param {string} key - One of FEATURE_KEYS.
 * @param {unknown} value - 0 or 1 (Gladys may hand over 1, "1" or true).
 * @returns {Promise<void>}
 * @throws {Error} On an unknown or read-only key, or a value other than 0/1;
 * an AdGuardError when AdGuard Home refuses the change.
 * @example
 * await applySetValue(client, 'protection', 0);
 */
export async function applySetValue(client, key, value) {
  const feature = FEATURES_BY_KEY.get(key);
  if (!feature) {
    throw new Error(`Unknown feature: ${key}`);
  }
  if (!feature.write) {
    throw new Error(`Feature ${key} is read-only`);
  }
  // Number(null) and Number('') are 0: they must not read as "off".
  const number = value === null || value === '' ? NaN : Number(value);
  if (number !== 0 && number !== 1) {
    throw new Error(`Invalid value for ${key}: expected 0 or 1`);
  }
  await feature.write(client, number === 1);
}
