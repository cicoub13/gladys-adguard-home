// -----------------------------------------------------------------------------
// Dashboard widgets: pure mapping Snapshot (src/adguard/snapshot.js) -> the
// widget content the `onWidgetGet` handlers resolve, plus the button actions
// of the `overview` widget.
//
// `overview` (7 components at most, budget 8): 3 tiles (queries, blocked,
// blocked share over 24 h), the focal chart of the last 24 hourly buckets, one
// status list (protection, safe browsing, parental control, safe search,
// version), an error text when the last poll failed, and one button: "Pause
// 10 min" while protection is on, "Resume protection" otherwise.
//
// `ranking`: one AdGuard top list (blocked domains, queried domains or
// clients) as `status` rows rather than a `card-list`: AdGuard returns up to
// 10 entries and `status` takes 10 rows (a `list` card-list only 8), each row
// is exactly "name / count" with the count kept a number, and the widget stays
// compact instead of taking the focal slot for 10 thumbnail-less rows. The
// price is a 40-character label (vs 60): longer domains are ellipsized here.
//
// AdGuard's top lists cover the whole statistics retention (a setting of
// AdGuard Home, often 24 h or 7 days) while the tiles and the chart are
// computed from the last 24 hourly buckets: the ranking caption says "over
// the statistics period", never "24 h".
//
// Status values are plain text the core never reformats (no time zone either):
// a paused protection shows the end of the pause in the local time of the
// Gladys instance ("paused until 17:20", see time.js). Chart dates, on the
// other hand, are ISO strings the core formats in each viewer's own time zone.
// Every human-readable text is a { en, fr } object; texts are
// clipped here to the vocabulary bounds so the content reaches the dashboard
// exactly as sent (validateWidgetContent reports nothing, see the tests).
// -----------------------------------------------------------------------------

import { formatLocalTime, isSameLocalDay } from './time.js';

export const OVERVIEW_WIDGET_KEY = 'overview';
export const RANKING_WIDGET_KEY = 'ranking';
export const PAUSE_ACTION_KEY = 'pause';
export const RESUME_ACTION_KEY = 'resume';

// Duration the overview "Pause" button declares in its params.
export const OVERVIEW_PAUSE_MS = 10 * 60 * 1000;
// Longest pause runOverviewAction accepts (params are declared by us, but the
// core relays whatever the last content carried: stay defensive).
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

const OVERVIEW_TTL_SECONDS = 60;
// Top lists move slowly; the lead's refresh nudge covers user-visible changes.
const RANKING_TTL_SECONDS = 300;

// Blocked share above which the tile turns to warning: a usual home network
// blocks 10-30 %; a majority blocked points at a chatty device or at
// over-aggressive filter lists.
const HIGH_BLOCKED_PERCENT = 50;

const MAX_RANKING_ROWS = 10;

// Vocabulary bounds (SDK README, "Dashboard widgets").
const STATUS_TEXT_MAX = 40;
const BODY_TEXT_MAX = 300;

export const RANKING_LISTS = {
  blocked_domains: {
    field: 'top_blocked_domains',
    caption: {
      en: 'Most blocked domains, over the statistics period',
      fr: 'Domaines les plus bloqués, sur la période des statistiques',
    },
    empty: {
      en: 'No domain has been blocked over the statistics period yet.',
      fr: "Aucun domaine n'a encore été bloqué sur la période des statistiques.",
    },
  },
  queried_domains: {
    field: 'top_queried_domains',
    caption: {
      en: 'Most queried domains, over the statistics period',
      fr: 'Domaines les plus demandés, sur la période des statistiques',
    },
    empty: {
      en: 'No DNS query has been recorded over the statistics period yet.',
      fr: "Aucune requête DNS n'a encore été enregistrée sur la période des statistiques.",
    },
  },
  clients: {
    field: 'top_clients',
    caption: {
      en: 'Most active clients, over the statistics period',
      fr: 'Clients les plus actifs, sur la période des statistiques',
    },
    empty: {
      en: 'No client has been recorded over the statistics period yet.',
      fr: "Aucun client n'a encore été enregistré sur la période des statistiques.",
    },
  },
};
export const DEFAULT_RANKING_LIST = 'blocked_domains';

const TEXT = {
  notReady: {
    en: 'No data from AdGuard Home yet. If this lasts, check the address and the account in the integration settings.',
    fr: "Pas encore de données d'AdGuard Home. Si cela dure, vérifiez l'adresse et le compte dans les paramètres de l'intégration.",
  },
  unavailable: { en: 'AdGuard Home unavailable', fr: 'AdGuard Home indisponible' },
  lastUpdate: { en: 'Last update', fr: 'Dernière mise à jour' },
  failed: { en: 'Failed, data may be outdated', fr: 'Échec, données peut-être périmées' },
  queries: { en: 'Queries (24 h)', fr: 'Requêtes (24 h)' },
  blocked: { en: 'Blocked (24 h)', fr: 'Bloquées (24 h)' },
  blockedShare: { en: 'Blocked share (24 h)', fr: 'Part bloquée (24 h)' },
  chartTitle: { en: 'Last 24 hours', fr: 'Dernières 24 heures' },
  queriesSeries: { en: 'Queries', fr: 'Requêtes' },
  blockedSeries: { en: 'Blocked', fr: 'Bloquées' },
  protection: { en: 'Protection', fr: 'Protection' },
  safeBrowsing: { en: 'Safe browsing', fr: 'Navigation sécurisée' },
  parental: { en: 'Parental control', fr: 'Contrôle parental' },
  safeSearch: { en: 'Safe search', fr: 'Recherche sécurisée' },
  version: { en: 'AdGuard Home version', fr: "Version d'AdGuard Home" },
  // Feminine: protection, navigation, recherche.
  onF: { en: 'On', fr: 'Activée' },
  offF: { en: 'Off', fr: 'Désactivée' },
  // Masculine: contrôle parental.
  onM: { en: 'On', fr: 'Activé' },
  offM: { en: 'Off', fr: 'Désactivé' },
  resuming: { en: 'Paused, resuming now', fr: 'En pause, reprise imminente' },
  pauseButton: { en: 'Pause 10 min', fr: 'Pause 10 min' },
  resumeButton: { en: 'Resume protection', fr: 'Reprendre la protection' },
  resumed: { en: 'DNS protection resumed', fr: 'Protection DNS réactivée' },
};

function clip(value, max) {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Clip a plain string or every language of a { en, fr } object.
function clipText(text, max) {
  if (typeof text === 'string') {
    return clip(text, max);
  }
  return Object.fromEntries(
    Object.entries(text).map(([language, value]) => [language, clip(String(value), max)]),
  );
}

/**
 * Human duration, identical in English and French ("30 s", "10 min", "1 h",
 * "7 h 05").
 * @param {number} ms - A duration in milliseconds.
 * @returns {string} The formatted duration.
 * @example
 * formatDuration(600000); // '10 min'
 */
export function formatDuration(ms) {
  if (ms < 60 * 1000) {
    return `${Math.max(1, Math.round(ms / 1000))} s`;
  }
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes).padStart(2, '0')}`;
}

// Content shown while no snapshot was ever fetched (not configured yet,
// AdGuard unreachable at boot).
function unavailableContent(error, ttlSeconds) {
  const components = error
    ? [
        { type: 'text', variant: 'caption', text: TEXT.unavailable },
        { type: 'text', variant: 'body', text: clipText(error, BODY_TEXT_MAX) },
      ]
    : [{ type: 'text', variant: 'body', text: TEXT.notReady }];
  return { version: 1, ttl_seconds: ttlSeconds, components };
}

const failedRow = () => ({ label: TEXT.lastUpdate, value: TEXT.failed, color: 'warning' });

function isPaused(snapshot) {
  return !snapshot.protection_enabled && Boolean(snapshot.protection_paused_until);
}

function protectionRow(snapshot, now, timeZone) {
  if (snapshot.protection_enabled) {
    return { label: TEXT.protection, value: TEXT.onF, color: 'success' };
  }
  if (isPaused(snapshot)) {
    const resumeAt = new Date(snapshot.protection_paused_until);
    if (resumeAt.getTime() <= now.getTime()) {
      return { label: TEXT.protection, value: TEXT.resuming, color: 'warning' };
    }
    // Local clock time of the Gladys instance (see time.js): status values
    // are shown as sent, never converted to the viewer's time zone.
    const time = formatLocalTime(resumeAt, timeZone);
    const value = isSameLocalDay(now, resumeAt, timeZone)
      ? { en: `Paused until ${time}`, fr: `En pause jusqu'à ${time}` }
      : { en: `Paused until tomorrow ${time}`, fr: `En pause jusqu'à demain ${time}` };
    return { label: TEXT.protection, value, color: 'warning' };
  }
  return { label: TEXT.protection, value: TEXT.offF, color: 'danger' };
}

function featureRow(label, enabled, onText, offText) {
  return { label, value: enabled ? onText : offText, color: enabled ? 'success' : 'neutral' };
}

function blockedPercentColor(percent) {
  if (percent > HIGH_BLOCKED_PERCENT) {
    return 'warning';
  }
  return percent > 0 ? 'success' : 'neutral';
}

function chartComponent(hourly) {
  const buckets = (Array.isArray(hourly) ? hourly : []).filter(
    (bucket) => bucket && !Number.isNaN(Date.parse(bucket.time)),
  );
  if (buckets.length === 0) {
    return null;
  }
  const series = (name, field) => ({
    name,
    points: buckets.map((bucket) => ({
      t: bucket.time,
      v: Number.isFinite(bucket[field]) ? bucket[field] : 0,
    })),
  });
  return {
    type: 'chart',
    chart_type: 'area',
    title: TEXT.chartTitle,
    series: [series(TEXT.queriesSeries, 'queries'), series(TEXT.blockedSeries, 'blocked')],
  };
}

/**
 * Build the `overview` widget content.
 * @param {object|null} snapshot - The last Snapshot, null when none was ever fetched.
 * @param {object} [options]
 * @param {Date} [options.now] - Reference instant (injectable for tests).
 * @param {{en: string, fr: string}|null} [options.error] - Message of the last failed poll.
 * @param {string} [options.timeZone] - Time zone of the pause end (defaults to the process TZ).
 * @returns {object} The widget content.
 * @example
 * buildOverviewContent(snapshot, { now: new Date(), error: null });
 */
export function buildOverviewContent(snapshot, { now = new Date(), error = null, timeZone } = {}) {
  if (!snapshot) {
    return unavailableContent(error, OVERVIEW_TTL_SECONDS);
  }
  const stats = snapshot.stats ?? {};
  const percent = Number.isFinite(stats.blocked_percent) ? stats.blocked_percent : 0;

  const components = [
    { type: 'value', label: TEXT.queries, value: stats.queries_24h ?? 0, icon: 'activity' },
    { type: 'value', label: TEXT.blocked, value: stats.blocked_24h ?? 0, icon: 'slash' },
    {
      type: 'value',
      label: TEXT.blockedShare,
      value: percent,
      unit: '%',
      icon: 'shield',
      color: blockedPercentColor(percent),
    },
  ];

  const chart = chartComponent(stats.hourly);
  if (chart) {
    components.push(chart);
  }

  const items = [
    protectionRow(snapshot, now, timeZone),
    featureRow(TEXT.safeBrowsing, snapshot.safebrowsing_enabled, TEXT.onF, TEXT.offF),
    featureRow(TEXT.parental, snapshot.parental_enabled, TEXT.onM, TEXT.offM),
    featureRow(TEXT.safeSearch, snapshot.safesearch_enabled, TEXT.onF, TEXT.offF),
  ];
  if (snapshot.version) {
    items.push({
      label: TEXT.version,
      value: clip(String(snapshot.version), STATUS_TEXT_MAX),
      color: 'neutral',
    });
  }
  if (error) {
    items.unshift(failedRow());
  }
  components.push({ type: 'status', items });

  if (error) {
    components.push({ type: 'text', variant: 'body', text: clipText(error, BODY_TEXT_MAX) });
  }

  components.push(
    snapshot.protection_enabled
      ? {
          type: 'button',
          label: TEXT.pauseButton,
          icon: 'pause',
          style: 'secondary',
          action: { key: PAUSE_ACTION_KEY, params: { duration_ms: OVERVIEW_PAUSE_MS } },
        }
      : {
          type: 'button',
          label: TEXT.resumeButton,
          icon: 'play',
          style: 'primary',
          action: { key: RESUME_ACTION_KEY },
        },
  );

  return { version: 1, ttl_seconds: OVERVIEW_TTL_SECONDS, components };
}

function rankingRow(listKey, entry) {
  const count = Number.isFinite(entry.count) ? entry.count : 0;
  let label = String(entry.name ?? '');
  if (listKey === 'clients' && entry.ip && entry.name !== entry.ip) {
    label = `${entry.name} (${entry.ip})`;
  }
  return { label: clip(label, STATUS_TEXT_MAX), value: count };
}

/**
 * Build the `ranking` widget content for the list chosen in the widget
 * settings (unknown or missing → most blocked domains).
 * @param {object|null} snapshot - The last Snapshot, null when none was ever fetched.
 * @param {{list?: string}} [settings] - The widget instance settings.
 * @param {object} [options]
 * @param {{en: string, fr: string}|null} [options.error] - Message of the last failed poll.
 * @returns {object} The widget content.
 * @example
 * buildRankingContent(snapshot, { list: 'clients' });
 */
export function buildRankingContent(snapshot, settings, { error = null } = {}) {
  if (!snapshot) {
    return unavailableContent(error, RANKING_TTL_SECONDS);
  }
  const listKey = Object.hasOwn(RANKING_LISTS, settings?.list)
    ? settings.list
    : DEFAULT_RANKING_LIST;
  const list = RANKING_LISTS[listKey];
  const entries = snapshot.stats?.[list.field];
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.name)
    .map((entry) => rankingRow(listKey, entry));

  const components = [{ type: 'text', variant: 'caption', text: list.caption }];
  if (error) {
    // The warning row takes one of the 10 status rows.
    components.push({
      type: 'status',
      items: [failedRow(), ...rows.slice(0, MAX_RANKING_ROWS - 1)],
    });
    components.push({ type: 'text', variant: 'body', text: clipText(error, BODY_TEXT_MAX) });
  } else if (rows.length > 0) {
    components.push({ type: 'status', items: rows.slice(0, MAX_RANKING_ROWS) });
  } else {
    components.push({ type: 'text', variant: 'body', text: list.empty });
  }
  return { version: 1, ttl_seconds: RANKING_TTL_SECONDS, components };
}

/**
 * Run a button action of the `overview` widget.
 * @param {object} client - An AdGuardClient (src/adguard/client.js).
 * @param {string} actionKey - PAUSE_ACTION_KEY or RESUME_ACTION_KEY.
 * @param {object} [params] - The declared params ({ duration_ms } for a pause).
 * @returns {Promise<{en: string, fr: string}>} The toast message.
 * @example
 * await runOverviewAction(client, 'pause', { duration_ms: 600000 });
 */
export async function runOverviewAction(client, actionKey, params) {
  if (actionKey === PAUSE_ACTION_KEY) {
    const durationMs = params?.duration_ms;
    if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_PAUSE_MS) {
      throw new Error(`Invalid pause duration: ${JSON.stringify(durationMs)}`);
    }
    await client.setProtection(false, durationMs);
    const duration = formatDuration(durationMs);
    return {
      en: `DNS protection paused for ${duration}`,
      fr: `Protection DNS en pause pour ${duration}`,
    };
  }
  if (actionKey === RESUME_ACTION_KEY) {
    await client.setProtection(true);
    return TEXT.resumed;
  }
  throw new Error(`Unknown overview action: ${JSON.stringify(actionKey)}`);
}
