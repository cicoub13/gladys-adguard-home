import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { AdGuardClient, AdGuardError, describeError } from '../src/adguard/client.js';
import * as fixtures from './fixtures/adguard.js';

const URL = 'http://192.168.1.10:3000';
const PASSWORD = 'p4ss-w0rd!';
const BASIC = Buffer.from(`admin:${PASSWORD}`).toString('base64');

/**
 * Fake fetch answering from a route table (`'METHOD /path'` -> Response
 * factory or thrown error), recording every call.
 */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new globalThis.URL(url).pathname;
    calls.push({
      url,
      path,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    });
    const route = routes[`${init.method} ${path}`];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    return route();
  };
  return { fetchImpl, calls };
}

const json =
  (body, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const makeClient = (fetchImpl, options = {}) =>
  new AdGuardClient({ url: URL, username: 'admin', password: PASSWORD, fetchImpl, ...options });

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

function assertNoSecret(err) {
  const everything = `${err.message} ${err.stack} ${inspect(err, { depth: 5 })} ${JSON.stringify(describeError(err))}`;
  assert.ok(!everything.includes(PASSWORD), 'the password leaked');
  assert.ok(!everything.includes(BASIC), 'the Authorization value leaked');
}

test('GET sends Basic auth when a username is set and parses the JSON', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'GET /control/status': json(fixtures.status()) });
  const status = await makeClient(fetchImpl).getStatus();

  assert.equal(status.version, 'v0.107.79');
  assert.equal(calls[0].url, `${URL}/control/status`);
  assert.equal(calls[0].headers.Authorization, `Basic ${BASIC}`);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('no Authorization header without a username', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'GET /control/status': json(fixtures.status()) });
  await new AdGuardClient({ url: `${URL}/`, username: '', password: 'x', fetchImpl }).getStatus();

  assert.equal(calls[0].url, `${URL}/control/status`);
  assert.equal('Authorization' in calls[0].headers, false);
});

test('the client object does not expose the credentials when logged', () => {
  const client = makeClient(async () => new Response('{}'));
  const dump = `${inspect(client, { depth: 5 })} ${JSON.stringify(client)}`;
  assert.ok(!dump.includes(PASSWORD));
  assert.ok(!dump.includes(BASIC));
});

test('every GET hits its endpoint', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'GET /control/stats': json(fixtures.stats()),
    'GET /control/safebrowsing/status': json(fixtures.safeBrowsingStatus()),
    'GET /control/parental/status': json(fixtures.parentalStatus()),
    'GET /control/safesearch/status': json(fixtures.safeSearchStatus()),
    'GET /control/clients': json(fixtures.clients()),
    'GET /control/blocked_services/get': json(fixtures.blockedServices()),
  });
  const client = makeClient(fetchImpl);

  assert.equal((await client.getStats()).time_units, 'hours');
  assert.deepEqual(await client.getSafeBrowsingStatus(), { enabled: false });
  assert.deepEqual(await client.getParentalStatus(), { enabled: false });
  assert.equal((await client.getSafeSearchStatus()).bing, true);
  assert.equal((await client.getClients()).clients.length, 3);
  assert.deepEqual((await client.getBlockedServices()).ids, []);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('401 and 403 -> kind auth, with the status', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = fakeFetch({
      'GET /control/status': () => new Response('Forbidden', { status }),
    });
    const err = await rejection(makeClient(fetchImpl).getStatus());
    assert.ok(err instanceof AdGuardError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, status);
    assertNoSecret(err);
  }
});

test('other non-2xx -> kind http', async () => {
  const { fetchImpl } = fakeFetch({
    'GET /control/stats': () => new Response('boom', { status: 500 }),
  });
  const err = await rejection(makeClient(fetchImpl).getStats());
  assert.equal(err.kind, 'http');
  assert.equal(err.status, 500);
  assert.match(describeError(err).en, /HTTP 500/);
  assertNoSecret(err);
});

test('network error -> kind unreachable, keeping the system code only', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${PASSWORD}`), { code: 'ECONNREFUSED' }),
    });
  };
  const err = await rejection(makeClient(fetchImpl).getStatus());
  assert.equal(err.kind, 'unreachable');
  assert.equal(err.code, 'ECONNREFUSED');
  assert.equal(err.cause, undefined);
  assert.match(describeError(err).en, /cannot be reached/);
  assertNoSecret(err);
});

test('TLS error -> unreachable, described as a certificate problem', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      }),
    });
  };
  const err = await rejection(makeClient(fetchImpl).getStatus());
  assert.equal(err.kind, 'unreachable');
  assert.match(describeError(err).en, /certificate/);
  assert.match(describeError(err).fr, /certificat/);
});

test('a request past the deadline -> kind timeout', async () => {
  // Never answers, but honors the AbortSignal like the real fetch.
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  const err = await rejection(makeClient(fetchImpl, { timeoutMs: 5 }).getStatus());
  assert.equal(err.kind, 'timeout');
  assert.match(describeError(err).fr, /pas répondu/);
  assertNoSecret(err);
});

test('an HTML page on a GET -> kind invalid_response', async () => {
  const { fetchImpl } = fakeFetch({
    'GET /control/status': () =>
      new Response('<!doctype html><title>Login</title>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  const err = await rejection(makeClient(fetchImpl).getStatus());
  assert.equal(err.kind, 'invalid_response');
  assertNoSecret(err);
});

test('writes accept an empty or plain-text 200 body', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST /control/safebrowsing/enable': () => new Response(null, { status: 200 }),
    'POST /control/parental/disable': () => new Response('OK'),
    'PUT /control/blocked_services/update': () => new Response(''),
    'POST /control/clients/update': () => new Response('OK'),
  });
  const client = makeClient(fetchImpl);

  assert.equal(await client.setSafeBrowsing(true), undefined);
  await client.setParental(false);
  await client.setBlockedServices({ ids: ['tiktok'], schedule: { time_zone: 'UTC' } });
  await client.updateClient('Phone', { name: 'Phone', ids: ['192.168.1.175'] });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /control/safebrowsing/enable',
      'POST /control/parental/disable',
      'PUT /control/blocked_services/update',
      'POST /control/clients/update',
    ],
  );
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(calls[2].body, { schedule: { time_zone: 'UTC' }, ids: ['tiktok'] });
  assert.equal(calls[2].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[3].body, {
    name: 'Phone',
    data: { name: 'Phone', ids: ['192.168.1.175'] },
  });
});

test('setProtection sends the duration only for a pause', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'POST /control/protection': () => new Response('') });
  const client = makeClient(fetchImpl);

  await client.setProtection(false, 600000);
  await client.setProtection(false);
  await client.setProtection(true, 600000);

  assert.deepEqual(
    calls.map((call) => call.body),
    [{ enabled: false, duration: 600000 }, { enabled: false }, { enabled: true }],
  );
});

test('setSafeSearch reads the settings, then PUTs the full object with enabled changed', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'GET /control/safesearch/status': json({ ...fixtures.safeSearchStatus(), bing: false }),
    'PUT /control/safesearch/settings': () => new Response(''),
  });
  await makeClient(fetchImpl).setSafeSearch(true);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ['GET /control/safesearch/status', 'PUT /control/safesearch/settings'],
  );
  assert.deepEqual(calls[1].body, { ...fixtures.safeSearchStatus(), bing: false, enabled: true });
});

test('a failed write is still an AdGuardError', async () => {
  const { fetchImpl } = fakeFetch({
    'POST /control/parental/enable': () => new Response('', { status: 401 }),
  });
  const err = await rejection(makeClient(fetchImpl).setParental(true));
  assert.equal(err.kind, 'auth');
  assertNoSecret(err);
});

test('describeError gives an en + fr message for every kind and for foreign errors', () => {
  const errors = [
    new AdGuardError('auth', 'x', { status: 401 }),
    new AdGuardError('timeout', 'x'),
    new AdGuardError('http', 'x', { status: 502 }),
    new AdGuardError('invalid_response', 'x'),
    new AdGuardError('unreachable', 'x', { code: 'ENOTFOUND' }),
    new Error('something else'),
    'not even an error',
  ];
  const messages = errors.map(describeError);
  for (const message of messages) {
    assert.equal(typeof message.en, 'string');
    assert.equal(typeof message.fr, 'string');
    assert.ok(message.en.length > 0 && message.fr.length > 0);
  }
  assert.equal(new Set(messages.map((message) => message.en)).size, messages.length - 1);
});
