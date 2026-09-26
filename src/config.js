// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of the manifest.
// This module only provides defaults, trims and coerces the types (a form may
// hand back strings), and tells whether there is enough to connect.
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  password: '',
  poll_frequency: 60,
};

// The only frequencies the manifest `select` offers (seconds): a stale or
// corrupted stored value snaps back to the default instead of flowing through.
export const POLL_FREQUENCY_OPTIONS = [30, 60, 300];

/**
 * Normalize the address typed by the user: trimmed, scheme defaulted to http,
 * no trailing slash and no `/control` suffix (the client adds it). Returns ''
 * when the value is not a usable http(s) URL.
 * @param {unknown} raw - The `url` config value.
 * @returns {string} The base URL, or '' when invalid.
 * @example
 * normalizeUrl('192.168.1.10:3000/'); // 'http://192.168.1.10:3000'
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return '';
  }
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return '';
  }
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/control$/, '');
  return `${parsed.origin}${path}`;
}

/**
 * Merge the user configuration with the defaults and coerce the types.
 * @param {Record<string, unknown>} [raw] - Configuration returned by the SDK.
 * @returns {{url: string, username: string, password: string, poll_frequency: number}} The normalized configuration.
 * @example
 * normalizeConfig({ url: 'http://192.168.1.10:3000', username: 'admin', password: 's3cret', poll_frequency: '30' });
 */
export function normalizeConfig(raw) {
  // `= {}` would not cover an explicit null, which getConfig() can return.
  const source = raw ?? {};
  const requestedFrequency = Number(source.poll_frequency);
  return {
    url: normalizeUrl(source.url),
    username: typeof source.username === 'string' ? source.username.trim() : '',
    password: typeof source.password === 'string' ? source.password : '',
    poll_frequency: POLL_FREQUENCY_OPTIONS.includes(requestedFrequency)
      ? requestedFrequency
      : DEFAULT_CONFIG.poll_frequency,
  };
}

/**
 * Whether the configuration holds what is needed to reach AdGuard Home.
 * Credentials are optional: an instance may run without authentication.
 * @param {{url: string}} config - A normalized configuration.
 * @returns {boolean} True when the URL is set.
 * @example
 * isConfigured(normalizeConfig(await gladys.getConfig()));
 */
export function isConfigured(config) {
  return config.url !== '';
}
