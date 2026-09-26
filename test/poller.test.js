import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.js';

// Manual timer queue, so each test decides when the next poll fires.
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
    async fireNext() {
      const [id, { fn }] = pending.entries().next().value;
      pending.delete(id);
      await fn();
    },
  };
}

// A run whose completion each test controls.
function deferredRuns() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      let resolve;
      const done = new Promise((r) => {
        resolve = r;
      });
      calls.push({
        resolve: () => {
          active -= 1;
          resolve();
        },
      });
      return done;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('start polls right away, then schedules the next poll once the first settled', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const poller = new Poller({ run: async () => runs++, intervalMs: 30000, ...timers });

  await poller.start();

  assert.equal(runs, 1);
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].delay, 30000);

  await timers.fireNext();
  assert.equal(runs, 2);
  assert.equal(timers.pending.size, 1, 'exactly one next poll scheduled');
});

test('no timer is armed while a slow poll is in flight', async () => {
  const timers = fakeTimers();
  const runs = deferredRuns();
  const poller = new Poller({ run: () => runs.run(), intervalMs: 1000, ...timers });

  const started = poller.start();
  await flush();
  assert.equal(timers.pending.size, 0);

  runs.calls[0].resolve();
  await started;
  assert.equal(timers.pending.size, 1);
});

test('stop cancels the next poll, and a poll in flight schedules nothing', async () => {
  const timers = fakeTimers();
  const runs = deferredRuns();
  const poller = new Poller({ run: () => runs.run(), intervalMs: 1000, ...timers });

  const started = poller.start();
  poller.stop();
  runs.calls[0].resolve();
  await started;

  assert.equal(timers.pending.size, 0);
  await poller.refreshNow();
  assert.equal(runs.calls.length, 1, 'refreshNow is a no-op once stopped');
});

test('refreshNow cancels the pending timer and polls immediately', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const poller = new Poller({ run: async () => runs++, intervalMs: 60000, ...timers });
  await poller.start();

  await poller.refreshNow();

  assert.equal(runs, 2);
  assert.equal(timers.pending.size, 1, 'the old timer was replaced, not doubled');
});

test('refreshNow during a poll waits for it, then runs a fresh one, never two at once', async () => {
  const timers = fakeTimers();
  const runs = deferredRuns();
  const poller = new Poller({ run: () => runs.run(), intervalMs: 1000, ...timers });

  const started = poller.start();
  const first = poller.refreshNow();
  const second = poller.refreshNow();
  await flush();
  assert.equal(runs.calls.length, 1, 'still waiting for the poll in flight');

  runs.calls[0].resolve();
  await started;
  await flush();
  assert.equal(runs.calls.length, 2);

  runs.calls[1].resolve();
  await flush();
  assert.equal(runs.calls.length, 3, 'the second command gets its own fresh poll');
  runs.calls[2].resolve();
  await Promise.all([first, second]);

  assert.equal(runs.maxActive, 1);
  assert.equal(timers.pending.size, 1);
});
