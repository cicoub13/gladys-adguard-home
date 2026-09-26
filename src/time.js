// -----------------------------------------------------------------------------
// Local time formatting, for the texts Gladys shows as they are (widget status
// rows, scene action outputs): unlike widget dates, the core never reformats
// them in the viewer's time zone.
//
// The time zone is the one of the Gladys instance: the supervisor injects it
// as the TZ env var, which Node applies to Intl by default. `timeZone` is only
// passed explicitly by the tests.
// -----------------------------------------------------------------------------

const partsOf = (date, timeZone) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
      timeZone,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );

/**
 * "HH:MM" on a 24 h clock, identical in English and French.
 * @param {Date} date - The instant to format.
 * @param {string} [timeZone] - IANA time zone, defaults to the process one (TZ).
 * @returns {string} The local time.
 * @example
 * formatLocalTime(new Date('2026-09-26T15:20:00Z'), 'Europe/Paris'); // '17:20'
 */
export function formatLocalTime(date, timeZone) {
  const { hour, minute } = partsOf(date, timeZone);
  return `${hour}:${minute}`;
}

/**
 * ISO 8601 with the local UTC offset instead of `Z`, e.g.
 * `2026-09-26T17:20:00+02:00`: the same instant, readable as local time.
 * @param {Date} date - The instant to format.
 * @param {string} [timeZone] - IANA time zone, defaults to the process one (TZ).
 * @returns {string} The local ISO 8601 date.
 * @example
 * toLocalIsoString(new Date('2026-09-26T15:20:00Z'), 'Europe/Paris'); // '2026-09-26T17:20:00+02:00'
 */
export function toLocalIsoString(date, timeZone) {
  const { year, month, day, hour, minute, second, timeZoneName } = partsOf(date, timeZone);
  // 'GMT+02:00', or plain 'GMT' for UTC itself.
  const offset = timeZoneName === 'GMT' ? '+00:00' : timeZoneName.replace('GMT', '');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/**
 * Whether two instants fall on the same local calendar day.
 * @param {Date} a - First instant.
 * @param {Date} b - Second instant.
 * @param {string} [timeZone] - IANA time zone, defaults to the process one (TZ).
 * @returns {boolean} True on the same local day.
 * @example
 * isSameLocalDay(now, resumeAt); // false when the pause ends tomorrow
 */
export function isSameLocalDay(a, b, timeZone) {
  const day = (date) => {
    const { year, month, day: dayOfMonth } = partsOf(date, timeZone);
    return `${year}-${month}-${dayOfMonth}`;
  };
  return day(a) === day(b);
}
