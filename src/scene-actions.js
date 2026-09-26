// -----------------------------------------------------------------------------
// Scene actions declared in the manifest `scene_actions`:
//
//   - `pause_protection`: timed pause of the DNS protection, AdGuard resumes it
//     by itself at the end of the pause;
//   - `blocked_services`: block or unblock a curated set of services, for the
//     whole network (the global list) or for ONE persistent client.
//
// The core already validates the fields against the manifest, but a scene
// variable or a stale scene can still hand over anything: every field is
// checked again here, and a bad one throws (the scene logs it and continues).
//
// Blocked services are merged, never replaced: ids outside the curated list
// (set from the AdGuard web interface) are kept untouched, and the global
// schedule is sent back as it was read.
// -----------------------------------------------------------------------------

import { formatLocalTime, toLocalIsoString } from './time.js';

export const PAUSE_PROTECTION_KEY = 'pause_protection';
export const BLOCKED_SERVICES_KEY = 'blocked_services';

// The manifest `duration` options, in milliseconds, same order.
export const PAUSE_DURATIONS_MS = [30000, 60000, 600000, 3600000, 28800000, 86400000];

// The manifest `services` options (AdGuard blocked-service ids), same order.
export const SERVICE_IDS = [
  'youtube',
  'tiktok',
  'instagram',
  'facebook',
  'snapchat',
  'twitter',
  'reddit',
  'pinterest',
  'whatsapp',
  'discord',
  'telegram',
  'netflix',
  'disneyplus',
  'amazon_streaming',
  'twitch',
  'spotify',
  'roblox',
  'minecraft',
  'epic_games',
  'steam',
  'playstation',
  'xboxlive',
  'nintendo',
  'leagueoflegends',
  'chatgpt',
];

const MODES = ['block', 'unblock'];

/**
 * `pause_protection`: pause the DNS protection for one of the manifest
 * durations.
 * @param {object} client - An AdGuardClient (src/adguard/client.js).
 * @param {{duration?: string}} fields - The resolved scene action fields.
 * @param {object} [options]
 * @param {Date} [options.now] - Reference instant (injectable for tests).
 * @param {string} [options.timeZone] - Time zone of the outputs (defaults to the process TZ, injected by Gladys).
 * @returns {Promise<{resume_at: string, resume_time: string}>} When AdGuard resumes the
 *   protection: local ISO 8601 with its UTC offset, and local "HH:MM" for a notification.
 * @example
 * await runPauseProtection(client, { duration: '600000' }); // { resume_at: '2026-09-26T17:20:00+02:00', resume_time: '17:20' }
 */
export async function runPauseProtection(client, fields, { now = new Date(), timeZone } = {}) {
  const raw = fields?.duration;
  const durationMs = PAUSE_DURATIONS_MS.find((ms) => String(ms) === String(raw));
  if (durationMs === undefined) {
    throw new Error(
      `Invalid pause duration ${JSON.stringify(raw)}: expected one of ${PAUSE_DURATIONS_MS.join(', ')} (ms)`,
    );
  }
  await client.setProtection(false, durationMs);
  const resumeAt = new Date(now.getTime() + durationMs);
  return {
    resume_at: toLocalIsoString(resumeAt, timeZone),
    resume_time: formatLocalTime(resumeAt, timeZone),
  };
}

// A multi_select resolves to an array; a scene variable may hand over a
// comma-separated string instead.
function parseServices(raw) {
  let values = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    values = raw.split(',');
  }
  const ids = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error('No service selected');
  }
  const unknown = ids.filter((id) => !SERVICE_IDS.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown service id(s): ${unknown.join(', ')}`);
  }
  return ids;
}

function applyMode(currentIds, services, mode) {
  const current = Array.isArray(currentIds) ? currentIds : [];
  const next =
    mode === 'block' ? [...current, ...services] : current.filter((id) => !services.includes(id));
  return [...new Set(next)];
}

function findPersistentClient(clients, target) {
  const wanted = target.toLowerCase();
  return clients.find(
    (candidate) =>
      String(candidate?.name ?? '').toLowerCase() === wanted ||
      (Array.isArray(candidate?.ids) &&
        candidate.ids.some((id) => String(id).toLowerCase() === wanted)),
  );
}

/**
 * `blocked_services`: block or unblock services, globally (empty `client`) or
 * for one persistent client matched by name (case-insensitive) or by one of
 * its ids (IP, CIDR, MAC or ClientID).
 * @param {object} client - An AdGuardClient (src/adguard/client.js).
 * @param {{mode?: string, services?: string[]|string, client?: string}} fields - The resolved fields.
 * @returns {Promise<{blocked_services: string}>} The resulting blocked ids, comma-separated.
 * @example
 * await runBlockedServices(client, { mode: 'block', services: ['tiktok'], client: 'Kids tablet' });
 */
export async function runBlockedServices(client, fields) {
  const mode = fields?.mode;
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid mode ${JSON.stringify(mode)}: expected "block" or "unblock"`);
  }
  const services = parseServices(fields?.services);
  const target = typeof fields?.client === 'string' ? fields.client.trim() : '';

  if (target === '') {
    const global = await client.getBlockedServices();
    const ids = applyMode(global?.ids, services, mode);
    await client.setBlockedServices({ ids, schedule: global?.schedule });
    return { blocked_services: ids.join(', ') };
  }

  const response = await client.getClients();
  const persistent = Array.isArray(response?.clients) ? response.clients : [];
  const found = findPersistentClient(persistent, target);
  if (!found) {
    throw new Error(
      `No persistent AdGuard Home client matches "${target}". Only persistent clients ` +
        '(configured in AdGuard Home > Settings > Client settings) can be targeted, by name, ' +
        'IP or ClientID; leave the client empty to change the whole network.',
    );
  }
  // A client following the global list starts from it, so switching it to its
  // own list does not silently drop the services blocked network-wide.
  const base =
    found.use_global_blocked_services === false
      ? found.blocked_services
      : (await client.getBlockedServices())?.ids;
  const ids = applyMode(base, services, mode);
  await client.updateClient(found.name, {
    ...found,
    use_global_blocked_services: false,
    blocked_services: ids,
  });
  return { blocked_services: ids.join(', ') };
}
