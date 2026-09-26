import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSnapshot, summarizeStats } from '../src/adguard/snapshot.js';
import { AdGuardError } from '../src/adguard/client.js';
import * as fixtures from './fixtures/adguard.js';

// 14:37:12 UTC: the current bucket starts at 14:00.
const NOW = new Date('2026-09-26T14:37:12.000Z');

/** Client double answering the fixtures, recording the calls in flight. */
function fakeClient(overrides = {}) {
  const client = { inFlight: 0, maxInFlight: 0 };
  const answer = (name, factory) => async () => {
    client.inFlight += 1;
    client.maxInFlight = Math.max(client.maxInFlight, client.inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    client.inFlight -= 1;
    if (overrides[name] instanceof Error) {
      throw overrides[name];
    }
    return name in overrides ? overrides[name] : factory();
  };
  client.getStatus = answer('status', fixtures.status);
  client.getStats = answer('stats', fixtures.stats);
  client.getSafeBrowsingStatus = answer('safeBrowsing', fixtures.safeBrowsingStatus);
  client.getParentalStatus = answer('parental', fixtures.parentalStatus);
  client.getSafeSearchStatus = answer('safeSearch', fixtures.safeSearchStatus);
  client.getClients = answer('clients', fixtures.clients);
  return client;
}

test('fetchSnapshot reads the status, then the five other reads in parallel', async () => {
  const client = fakeClient({ safeBrowsing: { enabled: true } });
  const snapshot = await fetchSnapshot(client, { now: NOW });

  assert.equal(client.maxInFlight, 5);
  assert.equal(snapshot.version, 'v0.107.79');
  assert.equal(snapshot.protection_enabled, true);
  assert.equal(snapshot.protection_paused_until, null);
  assert.equal(snapshot.safebrowsing_enabled, true);
  assert.equal(snapshot.parental_enabled, false);
  assert.equal(snapshot.safesearch_enabled, false);
  assert.equal(snapshot.fetched_at, NOW.toISOString());
  assert.equal(snapshot.stats.queries_24h, 30000);
});

test('fetchSnapshot dates the end of a timed pause', async () => {
  const status = {
    ...fixtures.status(),
    protection_enabled: false,
    protection_disabled_duration: 600000,
  };
  const snapshot = await fetchSnapshot(fakeClient({ status }), { now: NOW });

  assert.equal(snapshot.protection_enabled, false);
  assert.equal(snapshot.protection_paused_until, '2026-09-26T14:47:12.000Z');
});

test('fetchSnapshot rejects with the AdGuardError of a failed read', async () => {
  const failure = new AdGuardError('auth', 'GET /control/clients: authentication refused', {
    status: 401,
  });
  await assert.rejects(fetchSnapshot(fakeClient({ clients: failure }), { now: NOW }), failure);
});

test('a refused login costs one attempt, not six (AdGuard locks the IP out after 5)', async () => {
  const failure = new AdGuardError('auth', 'GET /control/status: authentication refused', {
    status: 401,
  });
  const client = fakeClient({ status: failure });
  const calls = [];
  for (const method of ['getStats', 'getSafeBrowsingStatus', 'getClients']) {
    const original = client[method];
    client[method] = (...args) => {
      calls.push(method);
      return original(...args);
    };
  }

  await assert.rejects(fetchSnapshot(client, { now: NOW }), failure);
  assert.deepEqual(calls, []);
});

test('fetchSnapshot survives garbage answers', async () => {
  const snapshot = await fetchSnapshot(
    fakeClient({
      status: null,
      stats: 'nope',
      safeBrowsing: [],
      parental: { enabled: 'yes' },
      safeSearch: undefined,
      clients: 42,
    }),
    { now: NOW },
  );
  assert.deepEqual(snapshot, {
    version: '',
    protection_enabled: false,
    protection_paused_until: null,
    safebrowsing_enabled: false,
    parental_enabled: false,
    safesearch_enabled: false,
    stats: {
      queries_24h: 0,
      blocked_24h: 0,
      blocked_percent: 0,
      avg_processing_ms: 0,
      hourly: [],
      top_blocked_domains: [],
      top_queried_domains: [],
      top_clients: [],
    },
    fetched_at: NOW.toISOString(),
  });
});

test('summarizeStats (hours) sums the last 24 buckets', () => {
  const stats = summarizeStats(fixtures.stats(), fixtures.clients(), NOW);

  assert.equal(stats.queries_24h, 30000);
  assert.equal(stats.blocked_24h, 3000);
  assert.equal(stats.blocked_percent, 10);
  assert.equal(stats.avg_processing_ms, 44.14);
});

test('summarizeStats (hours) dates the hourly buckets, the last one being the current hour', () => {
  const { hourly } = summarizeStats(fixtures.stats(), fixtures.clients(), NOW);

  assert.equal(hourly.length, 24);
  assert.deepEqual(hourly.at(-1), {
    time: '2026-09-26T14:00:00.000Z',
    queries: 2400,
    blocked: 240,
  });
  assert.deepEqual(hourly[0], { time: '2026-09-25T15:00:00.000Z', queries: 100, blocked: 10 });
  for (let i = 1; i < hourly.length; i += 1) {
    assert.equal(Date.parse(hourly[i].time) - Date.parse(hourly[i - 1].time), 60 * 60 * 1000);
  }
});

test('summarizeStats (hours) pads short series with zeros at the front', () => {
  const raw = { time_units: 'hours', dns_queries: [5, 7], blocked_filtering: [1] };
  const stats = summarizeStats(raw, {}, NOW);

  assert.equal(stats.hourly.length, 24);
  assert.deepEqual(
    stats.hourly.slice(-2).map(({ queries, blocked }) => [queries, blocked]),
    [
      [5, 0],
      [7, 1],
    ],
  );
  assert.equal(stats.queries_24h, 12);
  assert.equal(stats.blocked_24h, 1);
  assert.equal(stats.blocked_percent, 8.3);
});

test('summarizeStats (days) uses the last daily bucket and has no hourly series', () => {
  const raw = {
    ...fixtures.stats(),
    time_units: 'days',
    dns_queries: [90000, 80000, 12345],
    blocked_filtering: [9000, 8000, 1234],
  };
  const stats = summarizeStats(raw, fixtures.clients(), NOW);

  assert.equal(stats.queries_24h, 12345);
  assert.equal(stats.blocked_24h, 1234);
  assert.equal(stats.blocked_percent, 10);
  assert.deepEqual(stats.hourly, []);
});

test('summarizeStats never throws on empty or garbage stats', () => {
  const empty = {
    queries_24h: 0,
    blocked_24h: 0,
    blocked_percent: 0,
    avg_processing_ms: 0,
    hourly: [],
    top_blocked_domains: [],
    top_queried_domains: [],
    top_clients: [],
  };
  for (const raw of [undefined, null, {}, [], 'x', { time_units: 'weeks', dns_queries: [1] }]) {
    assert.deepEqual(summarizeStats(raw, undefined, NOW), empty);
  }

  const garbage = summarizeStats(
    {
      time_units: 'hours',
      dns_queries: ['12', null, 3],
      blocked_filtering: 'x',
      avg_processing_time: 'fast',
      top_blocked_domains: [null, 'x', {}, { 'ok.example': 'many' }, { 'good.example': 4 }],
      top_clients: 'x',
    },
    { clients: 'x', auto_clients: [null] },
    NOW,
  );
  assert.equal(garbage.queries_24h, 3);
  assert.equal(garbage.blocked_24h, 0);
  assert.equal(garbage.avg_processing_ms, 0);
  assert.deepEqual(garbage.top_blocked_domains, [
    { name: 'ok.example', count: 0 },
    { name: 'good.example', count: 4 },
  ]);
  assert.deepEqual(garbage.top_clients, []);
});

test('summarizeStats converts the top lists, keeping the AdGuard order, 10 entries max', () => {
  const raw = {
    ...fixtures.stats(),
    top_queried_domains: Array.from({ length: 15 }, (_, i) => ({ [`d${i}.example`]: 100 - i })),
  };
  const stats = summarizeStats(raw, fixtures.clients(), NOW);

  assert.deepEqual(stats.top_blocked_domains, [
    { name: 'app-analytics.example.com', count: 2589 },
    { name: 'telemetry.example.io', count: 1270 },
    { name: 'ads.example.net', count: 1168 },
  ]);
  assert.equal(stats.top_queried_domains.length, 10);
  assert.deepEqual(stats.top_queried_domains[0], { name: 'd0.example', count: 100 });
});

test('summarizeStats names the top clients: persistent, then auto, else the IP', () => {
  const raw = {
    ...fixtures.stats(),
    top_clients: [
      { '192.168.1.175': 82974 },
      { '192.168.1.119': 25319 },
      { '192.168.1.200': 12 },
      { '10.0.0.9': 3 },
    ],
  };
  const clients = fixtures.clients();
  // An auto client sharing a persistent client's IP must not win over it.
  clients.auto_clients.push({ ip: '192.168.1.175', name: 'phone.lan', source: 'rdns' });
  const { top_clients } = summarizeStats(raw, clients, NOW);

  assert.deepEqual(top_clients, [
    { name: 'Phone', ip: '192.168.1.175', count: 82974 },
    { name: 'Home server', ip: '192.168.1.119', count: 25319 },
    { name: 'printer.lan', ip: '192.168.1.200', count: 12 },
    { name: '10.0.0.9', ip: '10.0.0.9', count: 3 },
  ]);
});
