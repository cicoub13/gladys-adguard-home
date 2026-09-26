import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  buildOverviewContent,
  buildRankingContent,
  formatDuration,
  runOverviewAction,
  OVERVIEW_WIDGET_KEY,
  RANKING_WIDGET_KEY,
  PAUSE_ACTION_KEY,
  RESUME_ACTION_KEY,
  RANKING_LISTS,
  DEFAULT_RANKING_LIST,
} from '../src/widgets.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const NOW = new Date('2026-09-26T14:20:00.000Z');
const ERROR = {
  en: 'AdGuard Home is unreachable at http://192.168.1.10:3000. Check that it is running.',
  fr: "AdGuard Home est injoignable à l'adresse http://192.168.1.10:3000. Vérifiez qu'il fonctionne.",
};

// Hand-built Snapshot (shape of src/adguard/snapshot.js, see CONTRACTS.md).
function makeSnapshot(overrides = {}) {
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    time: new Date(Date.parse('2026-09-25T15:00:00.000Z') + i * 3600 * 1000).toISOString(),
    queries: (i + 1) * 100,
    blocked: (i + 1) * 10,
  }));
  const { stats, ...rest } = overrides;
  return {
    version: 'v0.107.79',
    protection_enabled: true,
    protection_paused_until: null,
    safebrowsing_enabled: false,
    parental_enabled: true,
    safesearch_enabled: false,
    fetched_at: NOW.toISOString(),
    ...rest,
    stats: {
      queries_24h: 30000,
      blocked_24h: 3000,
      blocked_percent: 10,
      avg_processing_ms: 44.14,
      hourly,
      top_blocked_domains: [
        { name: 'app-analytics.example.com', count: 2589 },
        { name: 'telemetry.example.io', count: 1270 },
      ],
      top_queried_domains: [{ name: 'api.example-cloud.com', count: 9120 }],
      top_clients: [
        { name: 'Phone', ip: '192.168.1.175', count: 82974 },
        { name: '192.168.1.200', ip: '192.168.1.200', count: 12 },
      ],
      ...stats,
    },
  };
}

const BUDGET = { total: 8, focal: 1, tiles: 6, texts: 2, body: 1, status: 1, button: 4 };
const FOCAL = ['chart', 'card-list', 'image'];

// Validates against the SDK (nothing dropped, truncated or altered) and the
// content budget, then returns the content for further assertions.
function assertValid(content) {
  assert.deepEqual(validateWidgetContent(content), []);
  const c = content.components;
  const count = (predicate) => c.filter(predicate).length;
  assert.ok(c.length <= BUDGET.total);
  assert.ok(count((x) => FOCAL.includes(x.type)) <= BUDGET.focal);
  assert.ok(count((x) => x.type === 'value' || x.type === 'gauge') <= BUDGET.tiles);
  assert.ok(count((x) => x.type === 'text') <= BUDGET.texts);
  assert.ok(count((x) => x.type === 'text' && (x.variant ?? 'body') === 'body') <= BUDGET.body);
  assert.ok(count((x) => x.type === 'status') <= BUDGET.status);
  assert.ok(count((x) => x.type === 'button') <= BUDGET.button);
  return content;
}

const byType = (content, type) => content.components.filter((c) => c.type === type);
const statusItems = (content) => byType(content, 'status')[0].items;
const itemByLabel = (content, en) => statusItems(content).find((item) => item.label.en === en);

test('widget keys match the manifest', () => {
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    [OVERVIEW_WIDGET_KEY, RANKING_WIDGET_KEY],
  );
});

test('overview, protection on: 3 tiles, 24 h chart, status rows and a pause button', () => {
  const content = assertValid(buildOverviewContent(makeSnapshot(), { now: NOW }));

  assert.deepEqual(
    byType(content, 'value').map((tile) => tile.value),
    [30000, 3000, 10],
  );
  assert.equal(byType(content, 'value')[2].unit, '%');
  assert.equal(byType(content, 'value')[2].color, 'success');

  const [chart] = byType(content, 'chart');
  assert.equal(chart.series.length, 2);
  assert.deepEqual(chart.series[0].name, { en: 'Queries', fr: 'Requêtes' });
  assert.equal(chart.series[0].points.length, 24);
  assert.deepEqual(chart.series[0].points[23], { t: '2026-09-26T14:00:00.000Z', v: 2400 });
  assert.deepEqual(chart.series[1].points[0], { t: '2026-09-25T15:00:00.000Z', v: 10 });

  assert.deepEqual(itemByLabel(content, 'Protection').value, { en: 'On', fr: 'Activée' });
  assert.equal(itemByLabel(content, 'Protection').color, 'success');
  assert.deepEqual(itemByLabel(content, 'Safe browsing').value, { en: 'Off', fr: 'Désactivée' });
  assert.deepEqual(itemByLabel(content, 'Parental control').value, { en: 'On', fr: 'Activé' });
  assert.deepEqual(itemByLabel(content, 'Safe search').value.fr, 'Désactivée');
  assert.equal(itemByLabel(content, 'AdGuard Home version').value, 'v0.107.79');
  assert.equal(itemByLabel(content, 'Last update'), undefined);
  assert.equal(byType(content, 'text').length, 0);

  const [button] = byType(content, 'button');
  assert.deepEqual(button.action, { key: PAUSE_ACTION_KEY, params: { duration_ms: 600000 } });
  assert.equal(button.label.fr, 'Pause 10 min');
});

// NOW is 16:20 in Paris (UTC+2 in September).
const PARIS = { now: NOW, timeZone: 'Europe/Paris' };

test('overview, protection paused: local end time in the status and a resume button', () => {
  const snapshot = makeSnapshot({
    protection_enabled: false,
    protection_paused_until: new Date(NOW.getTime() + 7.5 * 60 * 1000).toISOString(),
  });
  const content = assertValid(buildOverviewContent(snapshot, PARIS));

  const row = itemByLabel(content, 'Protection');
  assert.deepEqual(row.value, {
    en: 'Paused until 16:27',
    fr: "En pause jusqu'à 16:27",
  });
  assert.equal(row.color, 'warning');
  assert.deepEqual(byType(content, 'button')[0].action, { key: RESUME_ACTION_KEY });
  assert.equal(byType(content, 'button')[0].label.fr, 'Reprendre la protection');
});

test('overview, a pause ending after local midnight says "tomorrow", an elapsed one "resuming"', () => {
  const later = makeSnapshot({
    protection_enabled: false,
    protection_paused_until: new Date(NOW.getTime() + (7 * 60 + 5) * 60 * 1000).toISOString(),
  });
  assert.equal(
    itemByLabel(assertValid(buildOverviewContent(later, PARIS)), 'Protection').value.en,
    'Paused until 23:25',
  );

  // 8 h after 16:20 is 00:20 the next day in Paris (22:20 the same day in UTC).
  const tomorrow = makeSnapshot({
    protection_enabled: false,
    protection_paused_until: new Date(NOW.getTime() + 8 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(
    itemByLabel(assertValid(buildOverviewContent(tomorrow, PARIS)), 'Protection').value.fr,
    "En pause jusqu'à demain 00:20",
  );

  const elapsed = makeSnapshot({
    protection_enabled: false,
    protection_paused_until: new Date(NOW.getTime() - 1000).toISOString(),
  });
  assert.equal(
    itemByLabel(assertValid(buildOverviewContent(elapsed, { now: NOW })), 'Protection').value.fr,
    'En pause, reprise imminente',
  );
});

test('overview, protection off: danger row and a resume button', () => {
  const content = assertValid(
    buildOverviewContent(makeSnapshot({ protection_enabled: false }), { now: NOW }),
  );
  const row = itemByLabel(content, 'Protection');
  assert.deepEqual(row.value, { en: 'Off', fr: 'Désactivée' });
  assert.equal(row.color, 'danger');
  assert.equal(byType(content, 'button')[0].action.key, RESUME_ACTION_KEY);
});

test('overview, empty hourly (daily statistics): no chart', () => {
  const content = assertValid(
    buildOverviewContent(makeSnapshot({ stats: { hourly: [] } }), { now: NOW }),
  );
  assert.equal(byType(content, 'chart').length, 0);
  assert.equal(byType(content, 'value').length, 3);
});

test('overview, blocked share colors: neutral at 0, warning above 50 %', () => {
  const tile = (percent) =>
    byType(
      assertValid(
        buildOverviewContent(makeSnapshot({ stats: { blocked_percent: percent } }), { now: NOW }),
      ),
      'value',
    )[2];
  assert.equal(tile(0).color, 'neutral');
  assert.equal(tile(62.5).color, 'warning');
  assert.equal(tile(62.5).value, 62.5);
});

test('overview, null snapshot: short explanatory text only', () => {
  const content = assertValid(buildOverviewContent(null, { now: NOW }));
  assert.equal(content.components.length, 1);
  assert.equal(content.components[0].type, 'text');
  assert.match(content.components[0].text.fr, /paramètres de l'intégration/);
});

test('overview, null snapshot with an error: caption plus the error message', () => {
  const content = assertValid(buildOverviewContent(null, { now: NOW, error: ERROR }));
  assert.deepEqual(
    content.components.map((c) => c.variant),
    ['caption', 'body'],
  );
  assert.deepEqual(content.components[1].text, ERROR);
});

test('overview, error with a snapshot: last data kept, warning row and error text', () => {
  const content = assertValid(buildOverviewContent(makeSnapshot(), { now: NOW, error: ERROR }));
  assert.equal(byType(content, 'value').length, 3);
  assert.equal(byType(content, 'chart').length, 1);
  assert.equal(statusItems(content)[0].label.en, 'Last update');
  assert.equal(statusItems(content)[0].color, 'warning');
  assert.deepEqual(byType(content, 'text')[0].text, ERROR);
  assert.equal(byType(content, 'button').length, 1);
});

test('overview, an overlong error message is clipped to the body bound', () => {
  const long = { en: 'x'.repeat(500), fr: 'é'.repeat(500) };
  const content = assertValid(buildOverviewContent(makeSnapshot(), { now: NOW, error: long }));
  assert.equal(byType(content, 'text')[0].text.fr.length, 300);
});

test('ranking, each list: caption with the statistics-period nuance and count rows', () => {
  const snapshot = makeSnapshot();
  const blocked = assertValid(buildRankingContent(snapshot, { list: 'blocked_domains' }));
  assert.equal(byType(blocked, 'text')[0].variant, 'caption');
  assert.match(byType(blocked, 'text')[0].text.en, /statistics period/);
  assert.doesNotMatch(byType(blocked, 'text')[0].text.en, /24/);
  assert.deepEqual(statusItems(blocked), [
    { label: 'app-analytics.example.com', value: 2589 },
    { label: 'telemetry.example.io', value: 1270 },
  ]);

  const queried = assertValid(buildRankingContent(snapshot, { list: 'queried_domains' }));
  assert.equal(byType(queried, 'text')[0].text.fr, RANKING_LISTS.queried_domains.caption.fr);
  assert.deepEqual(statusItems(queried), [{ label: 'api.example-cloud.com', value: 9120 }]);

  const clients = assertValid(buildRankingContent(snapshot, { list: 'clients' }));
  assert.deepEqual(statusItems(clients), [
    { label: 'Phone (192.168.1.175)', value: 82974 },
    { label: '192.168.1.200', value: 12 },
  ]);
});

test('ranking, unknown or missing setting falls back to the most blocked domains', () => {
  const expected = RANKING_LISTS[DEFAULT_RANKING_LIST].caption;
  for (const settings of [{ list: 'bogus' }, {}, undefined, { list: 'toString' }]) {
    const content = assertValid(buildRankingContent(makeSnapshot(), settings));
    assert.deepEqual(byType(content, 'text')[0].text, expected);
  }
});

test('ranking options of the manifest are all handled', () => {
  const setting = manifest.widgets.find((w) => w.key === RANKING_WIDGET_KEY).settings[0];
  assert.deepEqual(
    setting.options.map((option) => option.value),
    Object.keys(RANKING_LISTS),
  );
  assert.equal(setting.default, DEFAULT_RANKING_LIST);
});

test('ranking, at most 10 rows and long domains clipped to 40 characters', () => {
  const top = Array.from({ length: 12 }, (_, i) => ({
    name: `${'very-long-subdomain-'.repeat(3)}${i}.example.com`,
    count: 100 - i,
  }));
  const content = assertValid(
    buildRankingContent(makeSnapshot({ stats: { top_blocked_domains: top } }), {}),
  );
  const items = statusItems(content);
  assert.equal(items.length, 10);
  assert.equal(items[0].label.length, 40);
  assert.ok(items[0].label.endsWith('…'));
});

test('ranking, empty list: friendly text instead of the status', () => {
  const content = assertValid(
    buildRankingContent(makeSnapshot({ stats: { top_clients: [] } }), { list: 'clients' }),
  );
  assert.equal(byType(content, 'status').length, 0);
  assert.deepEqual(byType(content, 'text')[1].text, RANKING_LISTS.clients.empty);
});

test('ranking, null snapshot, with and without error', () => {
  assertValid(buildRankingContent(null, { list: 'clients' }));
  const content = assertValid(buildRankingContent(null, {}, { error: ERROR }));
  assert.deepEqual(content.components[1].text, ERROR);
});

test('ranking, error: warning row first, 9 entries at most, error text', () => {
  const top = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}.example.com`, count: 10 - i }));
  const content = assertValid(
    buildRankingContent(
      makeSnapshot({ stats: { top_blocked_domains: top } }),
      {},
      { error: ERROR },
    ),
  );
  const items = statusItems(content);
  assert.equal(items.length, 10);
  assert.equal(items[0].color, 'warning');
  assert.equal(items[1].label, 'd0.example.com');
  assert.deepEqual(byType(content, 'text')[1].text, ERROR);

  const empty = assertValid(
    buildRankingContent(makeSnapshot({ stats: { top_blocked_domains: [] } }), {}, { error: ERROR }),
  );
  assert.equal(statusItems(empty).length, 1);
});

function fakeClient() {
  const calls = [];
  return {
    calls,
    async setProtection(...args) {
      calls.push(args);
    },
  };
}

test('runOverviewAction pause: timed pause and a bilingual toast', async () => {
  const client = fakeClient();
  const toast = await runOverviewAction(client, PAUSE_ACTION_KEY, { duration_ms: 600000 });
  assert.deepEqual(client.calls, [[false, 600000]]);
  assert.deepEqual(toast, {
    en: 'DNS protection paused for 10 min',
    fr: 'Protection DNS en pause pour 10 min',
  });
});

test('runOverviewAction resume: protection enabled again', async () => {
  const client = fakeClient();
  const toast = await runOverviewAction(client, RESUME_ACTION_KEY, {});
  assert.deepEqual(client.calls, [[true]]);
  assert.equal(toast.fr, 'Protection DNS réactivée');
});

test('runOverviewAction rejects invalid durations and unknown actions without calling AdGuard', async () => {
  const client = fakeClient();
  for (const params of [
    undefined,
    {},
    { duration_ms: '600000' },
    { duration_ms: 0 },
    { duration_ms: -1 },
    { duration_ms: 1.5 },
    { duration_ms: 24 * 3600 * 1000 + 1 },
  ]) {
    await assert.rejects(runOverviewAction(client, PAUSE_ACTION_KEY, params), /Invalid pause/);
  }
  await assert.rejects(runOverviewAction(client, 'reboot', {}), /Unknown overview action/);
  assert.deepEqual(client.calls, []);
});

test('formatDuration', () => {
  assert.equal(formatDuration(30000), '30 s');
  assert.equal(formatDuration(60000), '1 min');
  assert.equal(formatDuration(3600000), '1 h');
  assert.equal(formatDuration(86400000), '24 h');
  assert.equal(formatDuration((2 * 60 + 5) * 60000), '2 h 05');
});
