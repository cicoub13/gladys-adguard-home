// -----------------------------------------------------------------------------
// The integration itself: owns the AdGuard Home client, the polling loop and
// the last snapshot, and answers every SDK handler from them. index.js only
// wires these methods to the SDK, so everything here runs against a fake
// Gladys and a fake client in the tests.
//
// One Gladys integration instance talks to ONE AdGuard Home: the device and
// its feature ids are constants (see devices.js), the config only says where
// the instance lives.
// -----------------------------------------------------------------------------

import { logger as defaultLogger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './config.js';
import { AdGuardClient, describeError } from './adguard/client.js';
import { fetchSnapshot as defaultFetchSnapshot } from './adguard/snapshot.js';
import { applySetValue, buildDevice, buildStates, featureKeyOf } from './devices.js';
import { Poller } from './poller.js';
import {
  OVERVIEW_WIDGET_KEY,
  buildOverviewContent,
  buildRankingContent,
  runOverviewAction,
} from './widgets.js';
import { runBlockedServices, runPauseProtection } from './scene-actions.js';

const NOT_CONFIGURED = {
  en: 'Enter the AdGuard Home address in the configuration.',
  fr: "Saisissez l'adresse d'AdGuard Home dans la configuration.",
};

const INVALID_URL = {
  en: 'The AdGuard Home address is not valid: use http(s)://host:port, without username or password in it.',
  fr: "L'adresse d'AdGuard Home n'est pas valide : utilisez http(s)://hôte:port, sans identifiant ni mot de passe dedans.",
};

/**
 * Flatten a { en, fr } message into one string, for the places that only take
 * a string (a thrown Error shown under a button or in the scene logs).
 * @param {{en: string, fr: string}} message - The bilingual message.
 * @returns {string} "English / Français".
 * @example
 * bilingual({ en: 'Unreachable', fr: 'Injoignable' }); // 'Unreachable / Injoignable'
 */
export function bilingual(message) {
  return `${message.en} / ${message.fr}`;
}

export class AdGuardIntegration {
  /**
   * @param {object} gladys - The GladysIntegration SDK instance.
   * @param {object} [deps] - Injectable collaborators, for tests.
   * @param {(config: object) => object} [deps.createClient] - Builds the AdGuard client of a config.
   * @param {typeof defaultFetchSnapshot} [deps.fetchSnapshot] - Reads everything the integration shows.
   * @param {object} [deps.logger] - The SDK logger.
   * @param {typeof setTimeout} [deps.setTimer] - Injectable timer of the polling loop.
   * @param {typeof clearTimeout} [deps.clearTimer] - Injectable timer of the polling loop.
   */
  constructor(
    gladys,
    {
      createClient = (config) => new AdGuardClient(config),
      fetchSnapshot = defaultFetchSnapshot,
      logger = defaultLogger,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    } = {},
  ) {
    this.gladys = gladys;
    this.createClient = createClient;
    this.fetchSnapshot = fetchSnapshot;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.config = normalizeConfig();
    this.client = null;
    this.poller = null;
    this.snapshot = null;
    // { en, fr } message of the last failed poll, null once a poll succeeds.
    this.lastError = null;
    // Reachability last reported to Gladys: null (never), true or false.
    this.reportedConnected = null;
    this.reportedReason = null;
    // featureExternalId -> last value published, so a poll only publishes
    // what changed (the host API caps states at 300 per minute).
    this.published = new Map();
    this.devicePublished = false;
    // Bumped on every config change: a poll started under an older config
    // must not publish anything once it resolves.
    this.generation = 0;
  }

  /**
   * (Re)start from a configuration: tears down the previous client and loop.
   * @param {Record<string, unknown>} rawConfig - The configuration from the SDK.
   * @returns {Promise<void>} Settles once the first poll did.
   * @example
   * await integration.applyConfig(await gladys.getConfig());
   */
  async applyConfig(rawConfig) {
    this.stop();
    this.generation += 1;
    this.config = normalizeConfig(rawConfig);
    this.client = null;
    this.snapshot = null;
    this.lastError = null;
    this.reportedConnected = null;
    this.reportedReason = null;
    this.published.clear();
    this.devicePublished = false;

    if (!isConfigured(this.config)) {
      // An address was typed but could not be used: say so, rather than
      // asking for an address the user believes they already gave.
      const typed = typeof rawConfig?.url === 'string' && rawConfig.url.trim() !== '';
      this.logger.info(typed ? 'Invalid AdGuard Home address' : 'AdGuard Home address not set');
      this.lastError = typed ? INVALID_URL : NOT_CONFIGURED;
      await this.reportConnection(false, this.lastError);
      return;
    }

    this.client = this.createClient(this.config);
    this.logger.info(
      `Polling AdGuard Home at ${this.config.url} every ${this.config.poll_frequency}s`,
    );
    this.poller = new Poller({
      run: () => this.poll(),
      intervalMs: this.config.poll_frequency * 1000,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    await this.poller.start();
  }

  /**
   * One poll: read AdGuard Home, report reachability, publish what changed.
   * Never throws: a failure is logged, reported to Gladys and shown in the widgets.
   * @returns {Promise<void>}
   * @example
   * await integration.poll();
   */
  async poll() {
    const { generation, client } = this;
    let snapshot;
    try {
      snapshot = await this.fetchSnapshot(client);
    } catch (err) {
      if (generation === this.generation) {
        await this.handlePollFailure(err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.snapshot = snapshot;
    this.lastError = null;
    // Gladys-side failures (host API 429, WebSocket down) are not AdGuard
    // failures: logged, retried naturally by the next poll.
    try {
      if (this.reportedConnected !== true) {
        this.logger.info(`AdGuard Home ${snapshot.version} reachable at ${this.config.url}`);
      }
      await this.reportConnection(true);
      if (!this.devicePublished) {
        // Shown in the Discovery tab without the user having to scan.
        await this.gladys.publishDiscoveredDevices([buildDevice(this.gladys, this.config)]);
        this.devicePublished = true;
      }
      await this.publishChangedStates(snapshot);
    } catch (err) {
      this.logger.error('Could not publish to Gladys', err);
    }
  }

  async handlePollFailure(err) {
    this.lastError = describeError(err);
    if (err?.kind === 'auth') {
      // AdGuard Home locks an IP out after a few failed logins, its web
      // interface included: retrying a refused password every period would
      // lock the whole Gladys host out for good. Wait for a config change or
      // an explicit "Test the connection" instead.
      this.poller?.stop();
      this.lastError = {
        en: `${this.lastError.en} Polling is suspended until then.`,
        fr: `${this.lastError.fr} Les interrogations sont suspendues d'ici là.`,
      };
    }
    // Loud once per outage, quiet while it lasts.
    if (this.reportedConnected !== false) {
      this.logger.warn(`AdGuard Home poll failed: ${this.lastError.en}`, err);
    } else {
      this.logger.debug(`AdGuard Home still failing: ${this.lastError.en}`);
    }
    try {
      await this.reportConnection(false, this.lastError);
    } catch (statusErr) {
      this.logger.error('Could not report the connection status to Gladys', statusErr);
    }
  }

  /**
   * Report reachability to Gladys, only when it changed (a failure is sent
   * again when its reason changes: wrong password -> unreachable...).
   */
  async reportConnection(connected, message) {
    const reason = message?.en ?? null;
    if (this.reportedConnected === connected && this.reportedReason === reason) {
      return;
    }
    await this.gladys.setConnectionStatus(connected, message);
    this.reportedConnected = connected;
    this.reportedReason = reason;
  }

  async publishChangedStates(snapshot) {
    const changed = buildStates(this.gladys, snapshot).filter(
      ({ device_feature_external_id: id, state }) => this.published.get(id) !== state,
    );
    if (changed.length === 0) {
      return;
    }
    await this.gladys.publishStates(changed);
    for (const { device_feature_external_id: id, state } of changed) {
      this.published.set(id, state);
    }
  }

  requireClient() {
    if (!this.client) {
      throw new Error(bilingual(NOT_CONFIGURED));
    }
    return this.client;
  }

  /**
   * Run a write against AdGuard Home, turning its failure into a readable
   * error, then refresh Gladys and the overview widget so they show the result.
   * @param {(client: object) => Promise<T>} write - The write to run.
   * @returns {Promise<T>} What the write resolved.
   * @template T
   */
  async write(write) {
    const client = this.requireClient();
    let result;
    try {
      result = await write(client);
    } catch (err) {
      // Validation errors of our own modules are already readable.
      if (err?.name === 'AdGuardError') {
        throw new Error(bilingual(describeError(err)), { cause: err });
      }
      throw err;
    }
    await this.poller?.refreshNow();
    this.refreshWidget(OVERVIEW_WIDGET_KEY);
    return result;
  }

  refreshWidget(key) {
    try {
      this.gladys.requestWidgetRefresh(key);
    } catch (err) {
      this.logger.debug(`Widget refresh request for ${key} failed`, err);
    }
  }

  // --- SDK handlers ----------------------------------------------------------

  /** onScanRequest: the device does not depend on what AdGuard answers. */
  async handleScan() {
    this.requireClient();
    await this.gladys.publishDiscoveredDevices([buildDevice(this.gladys, this.config)]);
    this.devicePublished = true;
  }

  /** onSetValue: one of the four protection switches. */
  async handleSetValue(_device, feature, value) {
    const key = featureKeyOf(this.gladys, feature.external_id);
    if (key === null) {
      throw new Error(`Unknown feature ${feature.external_id}`);
    }
    this.logger.info(`onSetValue ${key} <- ${value}`);
    await this.write((client) => applySetValue(client, key, value));
    // The refresh above published the value AdGuard now reports; this covers
    // a refresh that failed (AdGuard down right after the command).
    if (this.lastError !== null && this.published.get(feature.external_id) !== value) {
      await this.gladys.publishState(feature.external_id, value);
      this.published.set(feature.external_id, value);
    }
  }

  /**
   * onDeviceCreated / onDeviceUpdated: states published before the user created
   * the device are dropped by the host API, so publish them all again.
   */
  async handleDeviceCreated() {
    this.published.clear();
    if (this.snapshot) {
      await this.publishChangedStates(this.snapshot);
    }
  }

  /** onDeviceDeleted: a device created again later must get its states again. */
  handleDeviceDeleted() {
    this.published.clear();
  }

  /** Manifest action `test_connection`: throws (shown in red) on failure. */
  async testConnection() {
    const client = this.requireClient();
    let snapshot;
    try {
      snapshot = await this.fetchSnapshot(client);
    } catch (err) {
      throw new Error(bilingual(describeError(err)), { cause: err });
    }
    // Also recovers right away after a fixed issue, including polling
    // suspended by a refused password (the credentials work again).
    if (this.poller?.stopped) {
      this.poller.start().catch(() => {});
    } else {
      this.poller?.refreshNow().catch(() => {});
    }
    return {
      en: `Connected to AdGuard Home ${snapshot.version}.`,
      fr: `Connecté à AdGuard Home ${snapshot.version}.`,
    };
  }

  widgetOverview() {
    return buildOverviewContent(this.snapshot, { error: this.lastError });
  }

  widgetRanking({ settings } = {}) {
    return buildRankingContent(this.snapshot, settings ?? {}, { error: this.lastError });
  }

  widgetOverviewAction(actionKey, params) {
    return this.write((client) => runOverviewAction(client, actionKey, params));
  }

  scenePauseProtection(fields) {
    return this.write((client) => runPauseProtection(client, fields));
  }

  sceneBlockedServices(fields) {
    return this.write((client) => runBlockedServices(client, fields));
  }

  /** Shutdown / config change: no timer left behind. */
  stop() {
    this.poller?.stop();
    this.poller = null;
  }
}
