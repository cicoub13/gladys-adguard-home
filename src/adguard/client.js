// -----------------------------------------------------------------------------
// Minimal AdGuard Home HTTP API client (`<url>/control/...`, JSON, HTTP Basic
// auth).
//
// Every failure is thrown as an AdGuardError whose `kind` tells what went
// wrong (unreachable, timeout, auth, http, invalid_response), so callers can
// turn it into an actionable message with describeError(). Credentials are
// kept in private fields and never copied into an error message: the client
// object and its errors can be logged safely. `fetchImpl` is injectable so unit
// tests never touch the real network.
// -----------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 10 * 1000;

/**
 * Error of an AdGuard Home request.
 * `kind`: 'unreachable' | 'timeout' | 'auth' | 'http' | 'invalid_response'.
 */
export class AdGuardError extends Error {
  /**
   * @param {string} kind - Failure category.
   * @param {string} message - Technical message (never contains credentials).
   * @param {{status?: number, code?: string}} [details] - HTTP status, or system error code.
   */
  constructor(kind, message, { status, code } = {}) {
    super(message);
    this.name = 'AdGuardError';
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
    if (code !== undefined) {
      this.code = code;
    }
  }
}

/**
 * Convert a rejection of fetch (or of the body read) into an AdGuardError.
 * Only the system error code is kept: the original error is dropped rather
 * than chained, so nothing from the request can leak through it.
 * @param {unknown} err - What fetch threw.
 * @param {string} label - `METHOD /path` of the request.
 * @returns {AdGuardError} The normalized error.
 */
function networkError(err, label) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AdGuardError('timeout', `${label}: AdGuard Home did not answer in time`);
  }
  // undici wraps the system error: TypeError('fetch failed', { cause }).
  const code = err?.cause?.code ?? err?.code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return new AdGuardError('unreachable', `${label}: AdGuard Home is unreachable${suffix}`, {
    code: typeof code === 'string' ? code : undefined,
  });
}

export class AdGuardClient {
  #authorization;

  /**
   * @param {object} options
   * @param {string} options.url - Base URL of the web interface, e.g. 'http://192.168.1.10:3000'.
   * @param {string} [options.username] - Login; no Authorization header is sent when empty.
   * @param {string} [options.password] - Password.
   * @param {typeof fetch} [options.fetchImpl] - Injectable for tests.
   * @param {number} [options.timeoutMs] - Deadline of one request (headers AND body).
   */
  constructor({
    url,
    username,
    password,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    this.baseUrl = String(url).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.#authorization = username
      ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
      : null;
  }

  /**
   * Send one request to the API.
   * @param {string} method - HTTP method.
   * @param {string} path - Path under the base URL, e.g. '/control/status'.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<any>} The parsed JSON of a GET, undefined for a write.
   */
  async request(method, path, body) {
    const label = `${method} ${path}`;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.#authorization) {
      headers.Authorization = this.#authorization;
    }

    let response;
    let text;
    try {
      // The same signal also aborts the body read below.
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      throw networkError(err, label);
    }

    const { status } = response;
    if (status === 401 || status === 403) {
      throw new AdGuardError('auth', `${label}: authentication refused (HTTP ${status})`, {
        status,
      });
    }
    if (!response.ok) {
      throw new AdGuardError('http', `${label}: HTTP ${status}`, { status });
    }
    // Several write endpoints answer an empty or plain-text ("OK") body.
    if (method !== 'GET') {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      // Typically an HTML page: a reverse proxy login, or the URL of another app.
      throw new AdGuardError('invalid_response', `${label}: the answer is not JSON`, { status });
    }
  }

  /** @returns {Promise<object>} GET /control/status. */
  getStatus() {
    return this.request('GET', '/control/status');
  }

  /** @returns {Promise<object>} GET /control/stats. */
  getStats() {
    return this.request('GET', '/control/stats');
  }

  /** @returns {Promise<{enabled: boolean}>} GET /control/safebrowsing/status. */
  getSafeBrowsingStatus() {
    return this.request('GET', '/control/safebrowsing/status');
  }

  /** @returns {Promise<{enabled: boolean}>} GET /control/parental/status. */
  getParentalStatus() {
    return this.request('GET', '/control/parental/status');
  }

  /** @returns {Promise<object>} GET /control/safesearch/status (`enabled` + one flag per engine). */
  getSafeSearchStatus() {
    return this.request('GET', '/control/safesearch/status');
  }

  /** @returns {Promise<{clients: object[], auto_clients: object[]}>} GET /control/clients. */
  getClients() {
    return this.request('GET', '/control/clients');
  }

  /** @returns {Promise<{schedule: object, ids: string[]}>} GET /control/blocked_services/get. */
  getBlockedServices() {
    return this.request('GET', '/control/blocked_services/get');
  }

  /**
   * Turn the DNS protection on or off; off with a duration is a timed pause.
   * @param {boolean} enabled - New protection state.
   * @param {number} [durationMs] - Pause length, only used when `enabled` is false.
   * @returns {Promise<void>}
   * @example
   * await client.setProtection(false, 10 * 60 * 1000); // pause for 10 minutes
   */
  async setProtection(enabled, durationMs) {
    const body = { enabled: Boolean(enabled) };
    if (!enabled && durationMs > 0) {
      body.duration = Math.round(durationMs);
    }
    await this.request('POST', '/control/protection', body);
  }

  /**
   * @param {boolean} enabled - New safe browsing state.
   * @returns {Promise<void>}
   * @example
   * await client.setSafeBrowsing(true);
   */
  async setSafeBrowsing(enabled) {
    await this.request('POST', `/control/safebrowsing/${enabled ? 'enable' : 'disable'}`);
  }

  /**
   * @param {boolean} enabled - New parental control state.
   * @returns {Promise<void>}
   * @example
   * await client.setParental(true);
   */
  async setParental(enabled) {
    await this.request('POST', `/control/parental/${enabled ? 'enable' : 'disable'}`);
  }

  /**
   * Toggle safe search, keeping the per-engine flags: the settings endpoint
   * replaces the whole object, so the current one is read first.
   * @param {boolean} enabled - New safe search state.
   * @returns {Promise<void>}
   * @example
   * await client.setSafeSearch(true);
   */
  async setSafeSearch(enabled) {
    const current = await this.getSafeSearchStatus();
    const settings = current !== null && typeof current === 'object' ? current : {};
    await this.request('PUT', '/control/safesearch/settings', {
      ...settings,
      enabled: Boolean(enabled),
    });
  }

  /**
   * Replace the globally blocked services.
   * @param {{ids: string[], schedule: object}} blocked - Service ids and schedule.
   * @returns {Promise<void>}
   * @example
   * await client.setBlockedServices({ ids: ['tiktok'], schedule: { time_zone: 'UTC' } });
   */
  async setBlockedServices({ ids, schedule }) {
    await this.request('PUT', '/control/blocked_services/update', { schedule, ids });
  }

  /**
   * Update a persistent client.
   * @param {string} name - Current name of the client.
   * @param {object} data - The full client object, modified.
   * @returns {Promise<void>}
   * @example
   * await client.updateClient('Kids tablet', { ...kidsTablet, blocked_services: ['tiktok'] });
   */
  async updateClient(name, data) {
    await this.request('POST', '/control/clients/update', { name, data });
  }
}

const TLS_CODE = /CERT|SSL|TLS|SELF_SIGNED/;

/**
 * User-facing, actionable message for any error (AdGuardError or not).
 * @param {unknown} err - The error to describe.
 * @returns {{en: string, fr: string}} The message.
 * @example
 * describeError(new AdGuardError('auth', '...', { status: 401 }));
 */
export function describeError(err) {
  if (!(err instanceof AdGuardError)) {
    return {
      en: 'Unexpected error while talking to AdGuard Home. Check the integration logs.',
      fr: "Erreur inattendue en communiquant avec AdGuard Home. Consultez les journaux de l'intégration.",
    };
  }
  switch (err.kind) {
    case 'auth':
      return {
        en: 'AdGuard Home refused the username or password. Check them in the integration settings.',
        fr: "AdGuard Home a refusé l'identifiant ou le mot de passe. Vérifiez-les dans les paramètres de l'intégration.",
      };
    case 'timeout':
      return {
        en: 'AdGuard Home did not answer in time. Check that it is running and that the address is right.',
        fr: "AdGuard Home n'a pas répondu à temps. Vérifiez qu'il fonctionne et que l'adresse est correcte.",
      };
    case 'http':
      return {
        en: `AdGuard Home answered with an error (HTTP ${err.status}). Check that it is up to date.`,
        fr: `AdGuard Home a répondu par une erreur (HTTP ${err.status}). Vérifiez qu'il est à jour.`,
      };
    case 'invalid_response':
      return {
        en: 'The address does not lead to the AdGuard Home API (unexpected answer). Check the address, the username and the password.',
        fr: "L'adresse ne mène pas à l'API d'AdGuard Home (réponse inattendue). Vérifiez l'adresse, l'identifiant et le mot de passe.",
      };
    default:
      if (typeof err.code === 'string' && TLS_CODE.test(err.code)) {
        return {
          en: 'The HTTPS certificate of AdGuard Home is not trusted. Use its http:// address or a valid certificate.',
          fr: "Le certificat HTTPS d'AdGuard Home n'est pas reconnu. Utilisez son adresse en http:// ou un certificat valide.",
        };
      }
      return {
        en: 'AdGuard Home cannot be reached. Check its address and that it is running.',
        fr: "AdGuard Home est injoignable. Vérifiez son adresse et qu'il fonctionne.",
      };
  }
}
