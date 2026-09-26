import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InitRetry, exitOnUnhandledRejection } from '../src/lifecycle.js';

// Manual timer queue, so each test decides when a scheduled retry fires.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimer(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.delay);
    },
    async fireNext() {
      const [id, entry] = pending.entries().next().value;
      pending.delete(id);
      await entry.fn();
    },
  };
}

function scriptedRun(outcomes) {
  const run = async () => {
    run.calls += 1;
    const outcome = outcomes[Math.min(run.calls - 1, outcomes.length - 1)];
    if (outcome instanceof Error) {
      throw outcome;
    }
  };
  run.calls = 0;
  return run;
}

function newRetry(run, timers, overrides = {}) {
  const failures = [];
  const retry = new InitRetry({
    run,
    onFailure: (err, delayMs) => failures.push({ err, delayMs }),
    minDelayMs: 1000,
    maxDelayMs: 8000,
    random: () => 1,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { retry, failures };
}

test('InitRetry runs once and schedules nothing when the first attempt succeeds', async () => {
  const timers = fakeTimers();
  const run = scriptedRun([undefined]);
  const { retry, failures } = newRetry(run, timers);

  await retry.start();

  assert.equal(run.calls, 1);
  assert.equal(failures.length, 0);
  assert.equal(timers.pending.size, 0);
});

test('InitRetry retries a failed attempt until it succeeds, then stops', async () => {
  const timers = fakeTimers();
  const run = scriptedRun([new Error('Celestrak down'), new Error('Celestrak down'), undefined]);
  const { retry, failures } = newRetry(run, timers);

  await retry.start();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].err.message, 'Celestrak down');
  assert.equal(timers.pending.size, 1);

  await timers.fireNext();
  await timers.fireNext();

  assert.equal(run.calls, 3);
  assert.equal(timers.pending.size, 0, 'no retry left once an attempt succeeded');
});

test('InitRetry doubles the delay after each failure and caps it', async () => {
  const timers = fakeTimers();
  const run = scriptedRun([new Error('down')]);
  const { retry, failures } = newRetry(run, timers);

  await retry.start();
  for (let i = 0; i < 5; i += 1) {
    await timers.fireNext();
  }

  assert.deepEqual(
    failures.map((failure) => failure.delayMs),
    [1000, 2000, 4000, 8000, 8000, 8000],
  );
});

test('InitRetry applies jitter within the upper half of the backoff delay', async () => {
  const timers = fakeTimers();
  const run = scriptedRun([new Error('down')]);
  const { retry } = newRetry(run, timers, { random: () => 0 });

  await retry.start();

  assert.deepEqual(timers.delays(), [500]);
});

test('InitRetry.start cancels a pending retry and restarts the backoff from scratch', async () => {
  const timers = fakeTimers();
  const run = scriptedRun([new Error('down'), new Error('down'), new Error('down')]);
  const { retry, failures } = newRetry(run, timers);

  await retry.start();
  await timers.fireNext();
  assert.deepEqual(timers.delays(), [2000]);

  // e.g. a WebSocket reconnection triggers a fresh initialization.
  await retry.start();

  assert.equal(timers.pending.size, 1, 'a single retry loop, never two');
  assert.deepEqual(timers.delays(), [1000]);
  assert.equal(failures.at(-1).delayMs, 1000);
});

test('InitRetry ignores the outcome of an attempt superseded by a newer start()', async () => {
  const timers = fakeTimers();
  let releaseFirst;
  let calls = 0;
  const run = () => {
    calls += 1;
    if (calls === 1) {
      return new Promise((resolve, reject) => {
        releaseFirst = () => reject(new Error('stale failure'));
      });
    }
    return Promise.resolve();
  };
  const { retry, failures } = newRetry(run, timers);

  const first = retry.start();
  await retry.start();
  releaseFirst();
  await first;

  assert.equal(failures.length, 0);
  assert.equal(timers.pending.size, 0);
});

test('InitRetry.stop cancels the pending retry and prevents new ones', async () => {
  const timers = fakeTimers();
  let releaseRun;
  const run = () =>
    new Promise((resolve, reject) => {
      releaseRun = () => reject(new Error('down'));
    });
  const { retry, failures } = newRetry(run, timers);

  const attempt = retry.start();
  retry.stop();
  releaseRun();
  await attempt;

  assert.equal(failures.length, 0);
  assert.equal(timers.pending.size, 0);
});

test('exitOnUnhandledRejection logs the reason at error level, then exits with code 1', () => {
  const processRef = new EventEmitter();
  const logged = [];
  const exits = [];
  exitOnUnhandledRejection({
    logger: { error: (...args) => logged.push(args) },
    exit: (code) => exits.push(code),
    processRef,
  });

  const reason = new Error('boom');
  processRef.emit('unhandledRejection', reason);

  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes(reason));
  assert.deepEqual(exits, [1]);
});
