import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalTime, isSameLocalDay, toLocalIsoString } from '../src/time.js';

const SUMMER = new Date('2026-09-26T15:20:05.000Z');
const WINTER = new Date('2026-12-26T15:20:05.000Z');

test('formatLocalTime is a 24 h clock in the given time zone, DST included', () => {
  assert.equal(formatLocalTime(SUMMER, 'Europe/Paris'), '17:20');
  assert.equal(formatLocalTime(WINTER, 'Europe/Paris'), '16:20');
  assert.equal(formatLocalTime(SUMMER, 'UTC'), '15:20');
  assert.equal(formatLocalTime(new Date('2026-09-26T22:05:00Z'), 'Europe/Paris'), '00:05');
});

test('toLocalIsoString keeps the instant and writes the local offset', () => {
  assert.equal(toLocalIsoString(SUMMER, 'Europe/Paris'), '2026-09-26T17:20:05+02:00');
  assert.equal(toLocalIsoString(WINTER, 'Europe/Paris'), '2026-12-26T16:20:05+01:00');
  assert.equal(toLocalIsoString(SUMMER, 'UTC'), '2026-09-26T15:20:05+00:00');
  assert.equal(toLocalIsoString(SUMMER, 'America/New_York'), '2026-09-26T11:20:05-04:00');
  for (const timeZone of ['Europe/Paris', 'UTC', 'Asia/Kolkata', 'America/New_York']) {
    const iso = toLocalIsoString(SUMMER, timeZone);
    assert.equal(new Date(iso).getTime(), SUMMER.getTime(), `${timeZone}: ${iso}`);
  }
});

test('isSameLocalDay compares local calendar days, not UTC ones', () => {
  const evening = new Date('2026-09-26T21:30:00Z'); // 23:30 in Paris
  const lateNight = new Date('2026-09-26T22:30:00Z'); // 00:30 the 27th in Paris
  assert.equal(isSameLocalDay(evening, lateNight, 'UTC'), true);
  assert.equal(isSameLocalDay(evening, lateNight, 'Europe/Paris'), false);
});

test('without an explicit zone, the process time zone (TZ injected by Gladys) is used', () => {
  const expected = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(SUMMER);
  assert.equal(formatLocalTime(SUMMER), expected);
});
