// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
// Reproduces only the surface the integration relies on, recording every call
// (pattern borrowed from ../gladys-tp-link/test/helpers/fakeGladys.js). The
// external ids follow the SDK format `ext:<selector>:<type>:<platformId>[:<key>]`.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const calls = {
    states: [],
    discovered: [],
    connectionStatuses: [],
    widgetRefreshes: [],
  };
  const failures = {};

  function maybeFail(method) {
    if (failures[method] > 0) {
      failures[method] -= 1;
      const err = new Error('Too Many Requests');
      err.status = 429;
      throw err;
    }
  }

  return {
    calls,

    /** The next `times` calls of `method` reject like a host API 429. */
    failNext(method, times = 1) {
      failures[method] = times;
    },

    externalIds(type, platformId) {
      const device = `ext:test:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    externalId(suffix) {
      return `ext:test:${suffix}`;
    },

    async publishState(featureExternalId, state) {
      maybeFail('publishState');
      calls.states.push({ device_feature_external_id: featureExternalId, state });
    },

    async publishStates(states) {
      maybeFail('publishStates');
      calls.states.push(...states);
    },

    async publishDiscoveredDevices(devices) {
      maybeFail('publishDiscoveredDevices');
      calls.discovered.push(devices);
    },

    async setConnectionStatus(connected, message) {
      maybeFail('setConnectionStatus');
      calls.connectionStatuses.push({ connected, message });
    },

    requestWidgetRefresh(key) {
      calls.widgetRefreshes.push(key);
    },
  };
}
