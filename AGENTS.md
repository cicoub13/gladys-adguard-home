# AGENTS.md: gladys-adguard-home

Project-specific notes. Generic rules (SDK contract, commands, kit-owned files, runtime) are in
`CLAUDE.md`; the module tree and user-facing features are in `README.md`.

## Data flow

- `index.js` -> `AdGuardIntegration` (`src/integration.js`) holds everything: `client`, `poller`,
  last `snapshot`, `lastError` ({en, fr}), `published` Map (feature id -> last state).
- `applyConfig()` resets all state, bumps `generation`, builds a new client, starts a `Poller`.
  A poll whose `generation` is stale when it resolves publishes nothing (config changed meanwhile).
- `poll()`: `fetchSnapshot()` -> `reportConnection(true)` -> `publishDiscoveredDevices` once per
  config (device shows up in Discovery without a scan) -> `publishChangedStates()` (diff against
  `published`, host API caps states at 300/min). `poll()` never throws.
- Gladys-side errors (429, WS down) inside a successful poll are only logged, never treated as an
  AdGuard outage. `reportConnection` only calls `setConnectionStatus` when state OR reason changes.
- Every write (switch, widget button, scene action) goes through `integration.write()`: wraps
  `AdGuardError` into a bilingual `Error` ("en / fr"), then `poller.refreshNow()` and
  `requestWidgetRefresh('overview')`.
- `onDeviceCreated`/`onDeviceUpdated` clear `published` and republish (states sent before creation
  are dropped by the host); `onDeviceDeleted` just clears `published`.
- Widgets/scene actions are pure functions over the snapshot (`src/widgets.js`,
  `src/scene-actions.js`); they get the client, never Gladys.

## AdGuard Home API (`src/adguard/client.js`)

- REST under `<url>/control/*`, JSON, HTTP Basic auth only if `username` is non-empty. Tested
  against v0.107.79 (`test/fixtures/adguard.js`). Pull only, no push: polling every 30/60/300 s.
- Reads: `status`, `stats`, `safebrowsing/status`, `parental/status`, `safesearch/status`,
  `clients`, `blocked_services/get`. Writes: `POST protection` (`duration` ms only for a pause),
  `POST safebrowsing|parental/enable|disable`, `PUT safesearch/settings`,
  `PUT blocked_services/update`, `POST clients/update`.
- Writes may return an empty or plain-text `OK` body: only GET bodies are parsed.
  A non-JSON GET body (reverse-proxy login page, wrong app) -> `invalid_response`.
- `AdGuardError.kind`: `unreachable` | `timeout` | `auth` (401/403) | `http` | `invalid_response`.
  `describeError()` maps them (plus TLS codes) to {en, fr} messages. 10 s timeout covers body too.
- Credentials live in a private field and are never put in errors (the original fetch error is
  dropped, only `cause.code` kept). `test/client.test.js` asserts nothing leaks: keep it that way.
- **Login lockout**: AdGuard locks an IP after ~5 failed logins for 15 min (web UI included).
  Hence `fetchSnapshot` calls `getStatus()` alone first, then the 5 others in parallel, and an
  `auth` failure stops the poller until a config change or `test_connection` restarts it.
- `setSafeSearch` must GET the settings then PUT the whole object (the endpoint replaces it).
- Blocked services are merged, never replaced: foreign ids and the global `schedule` are sent
  back. A per-client change targets persistent clients only (matched by name case-insensitively
  or by any id), sets `use_global_blocked_services: false` and starts from the global list if
  the client was following it.

## Snapshot (`src/adguard/snapshot.js`)

- Untrusted API: bad fields fall back to 0 / [] / false, never throw.
- `time_units: 'hours'`: 24 h figures = sum of last 24 buckets (last = current partial hour),
  buckets aligned on Unix hours. `'days'`: only today's bucket, `hourly` is empty.
- Top lists (`[{name: count}]`) cover AdGuard's whole retention period, not 24 h: widget
  captions must say "over the statistics period". Top clients get names from persistent then
  auto clients.

## Devices: must stay stable

- One device per integration instance, ids are constants, deliberately NOT derived from the URL
  (AdGuard has no instance id): `gladys.externalIds('adguard-home', 'main')`, features
  `<device>:<key>` with keys in `FEATURE_KEYS` (`src/devices.js`): `protection`, `safebrowsing`,
  `parental`, `safesearch`, `queries_24h`, `blocked_24h`, `blocked_percent`,
  `avg_processing_time`. Device param `ADGUARD_URL`. `FEATURES` order = display order.
- `blocked_percent` is a rounded integer `counter-sensor` (no generic percent category in
  Gladys); the widget keeps the decimal. `applySetValue` rejects `null`/`''` (not "off").

## Config and storage

- Keys: `url`, `username`, `password` (secret), `poll_frequency` (string `"30"|"60"|"300"` in the
  manifest, coerced to a number; anything else -> 60). `normalizeUrl` adds `http://`, strips
  trailing `/` and `/control`, rejects non-http(s) and userinfo URLs (distinct "invalid address"
  message vs "not set").
- Nothing is written to `/data`.

## Time

- Status rows and scene outputs (`resume_time` HH:MM, `resume_at` ISO with offset) are local time
  via `src/time.js` (Intl, `TZ`); chart dates stay UTC ISO (the core localizes them).
  `timeZone` params exist only for tests.

## Tests

- `test/helpers/fakeGladys.js`: records calls, `failNext(method, n)` simulates host 429s.
- `test/fixtures/adguard.js`: factories of real API answers; `stats()` has 168 hourly buckets
  with a recognizable last-24 h ramp (24 h sums differ from the 7-day totals).
- `test/client.test.js` uses a route-table `fakeFetch`; `test/integration.test.js` injects
  `createClient`, a scripted `fetchSnapshot` (outcomes list), logger and timers.
- `test/widgets.test.js` asserts `validateWidgetContent(content)` is empty: texts are clipped to
  40 (status) / 300 (body) chars in `widgets.js`.
- `test/manifest.test.js` and `test/scene-actions.test.js` cross-check the manifest with code:
  `SERVICE_IDS` / `PAUSE_DURATIONS_MS` must equal the manifest options in the same order, and
  every widget/scene action/action needs a handler in `index.js`. Update both sides together.
- `npm run coverage`: lines 90 %, branches/functions 85 % (needs Node >= 22.8).
