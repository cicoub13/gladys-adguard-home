// -----------------------------------------------------------------------------
// One polling round: the six AdGuard Home reads (status first, then the other
// five in parallel), reduced to the plain "snapshot" object the devices,
// widgets and poller work with.
//
// The API answers are not trusted: a missing or garbage field never throws,
// it falls back to [] for a list, 0 for a number and false for a flag.
// -----------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;
const TOP_LIST_LENGTH = 10;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const toNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const toNumbers = (value) => (Array.isArray(value) ? value.map(toNumber) : []);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/**
 * Convert an AdGuard top list (`[{ "<name>": count }, ...]`) to `[{ name, count }]`.
 * @param {unknown} list - Raw top list.
 * @returns {Array<{name: string, count: number}>} Up to TOP_LIST_LENGTH entries, in AdGuard's order.
 */
function parseTopList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter(isObject)
    .map((entry) => Object.entries(entry)[0])
    .filter((pair) => pair !== undefined)
    .map(([name, count]) => ({ name, count: toNumber(count) }))
    .slice(0, TOP_LIST_LENGTH);
}

/**
 * Map every known client identifier (IP, ClientID...) to a display name:
 * persistent clients first, then the automatically discovered ones.
 * @param {unknown} clientsResponse - GET /control/clients answer.
 * @returns {Map<string, string>} Identifier -> name.
 */
function clientNames(clientsResponse) {
  const names = new Map();
  const response = isObject(clientsResponse) ? clientsResponse : {};
  const persistent = Array.isArray(response.clients) ? response.clients : [];
  const auto = Array.isArray(response.auto_clients) ? response.auto_clients : [];
  for (const client of persistent.filter(isObject)) {
    if (typeof client.name !== 'string' || client.name === '' || !Array.isArray(client.ids)) {
      continue;
    }
    for (const id of client.ids) {
      if (typeof id === 'string' && !names.has(id)) {
        names.set(id, client.name);
      }
    }
  }
  for (const client of auto.filter(isObject)) {
    if (typeof client.ip === 'string' && typeof client.name === 'string' && client.name !== '') {
      if (!names.has(client.ip)) {
        names.set(client.ip, client.name);
      }
    }
  }
  return names;
}

/**
 * Reduce GET /control/stats (+ the clients, for names) to the snapshot stats.
 *
 * With `time_units: 'hours'` the buckets are hours, the last one being the
 * current (partial) hour: the 24 h figures are the sum of the last 24 buckets.
 * With 'days' only the last daily bucket (today) is available and there is no
 * hourly series.
 * @param {unknown} stats - GET /control/stats answer.
 * @param {unknown} clientsResponse - GET /control/clients answer.
 * @param {Date} now - Current time, to date the hourly buckets.
 * @returns {object} The `stats` part of a snapshot.
 * @example
 * summarizeStats(await client.getStats(), await client.getClients(), new Date());
 */
export function summarizeStats(stats, clientsResponse, now) {
  const source = isObject(stats) ? stats : {};
  const queries = toNumbers(source.dns_queries);
  const blocked = toNumbers(source.blocked_filtering);

  let queries24h = 0;
  let blocked24h = 0;
  let hourly = [];
  if (source.time_units === 'hours') {
    // The two series normally have the same length; align them on their end
    // (the current hour) and pad a short one with zeros at the front.
    const lastDay = (series) => {
      const tail = series.slice(-HOURS_PER_DAY);
      return [...Array(HOURS_PER_DAY - tail.length).fill(0), ...tail];
    };
    const hourlyQueries = lastDay(queries);
    const hourlyBlocked = lastDay(blocked);
    queries24h = sum(hourlyQueries);
    blocked24h = sum(hourlyBlocked);
    // AdGuard buckets are aligned on Unix hours.
    const currentHourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    hourly = hourlyQueries.map((count, index) => ({
      time: new Date(currentHourStart - (HOURS_PER_DAY - 1 - index) * HOUR_MS).toISOString(),
      queries: count,
      blocked: hourlyBlocked[index],
    }));
  } else if (source.time_units === 'days') {
    queries24h = queries.at(-1) ?? 0;
    blocked24h = blocked.at(-1) ?? 0;
  }

  const names = clientNames(clientsResponse);
  return {
    queries_24h: queries24h,
    blocked_24h: blocked24h,
    blocked_percent: queries24h > 0 ? round((blocked24h / queries24h) * 100, 1) : 0,
    avg_processing_ms: round(toNumber(source.avg_processing_time) * 1000, 2),
    hourly,
    top_blocked_domains: parseTopList(source.top_blocked_domains),
    top_queried_domains: parseTopList(source.top_queried_domains),
    top_clients: parseTopList(source.top_clients).map(({ name: ip, count }) => ({
      name: names.get(ip) ?? ip,
      ip,
      count,
    })),
  };
}

/**
 * Fetch everything the integration shows, in parallel, as one snapshot.
 * Rejects with the first AdGuardError when any of the reads fails.
 * @param {import('./client.js').AdGuardClient} client - The AdGuard Home client.
 * @param {{now?: Date}} [options] - Injectable clock, for tests.
 * @returns {Promise<object>} The snapshot.
 * @example
 * const snapshot = await fetchSnapshot(client);
 */
export async function fetchSnapshot(client, { now = new Date() } = {}) {
  // Status alone first: AdGuard Home locks an IP out after a few failed logins
  // (5 by default, for 15 min, web interface included). With a wrong password
  // one poll must cost one failed attempt, not six parallel ones.
  const status = await client.getStatus();
  const [stats, safeBrowsing, parental, safeSearch, clients] = await Promise.all([
    client.getStats(),
    client.getSafeBrowsingStatus(),
    client.getParentalStatus(),
    client.getSafeSearchStatus(),
    client.getClients(),
  ]);
  const statusObject = isObject(status) ? status : {};
  const pausedMs = toNumber(statusObject.protection_disabled_duration);
  return {
    version: typeof statusObject.version === 'string' ? statusObject.version : '',
    protection_enabled: statusObject.protection_enabled === true,
    protection_paused_until: pausedMs > 0 ? new Date(now.getTime() + pausedMs).toISOString() : null,
    safebrowsing_enabled: isObject(safeBrowsing) && safeBrowsing.enabled === true,
    parental_enabled: isObject(parental) && parental.enabled === true,
    safesearch_enabled: isObject(safeSearch) && safeSearch.enabled === true,
    stats: summarizeStats(stats, clients, now),
    fetched_at: now.toISOString(),
  };
}
