// -----------------------------------------------------------------------------
// The manifest and the code state some facts twice (config defaults, widget
// and scene action keys, the curated services, the pause durations). Nothing
// links them at runtime, and a divergence fails at the worst possible moment.
// These tests are that link.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { DEFAULT_CONFIG, POLL_FREQUENCY_OPTIONS } from '../src/config.js';
import { OVERVIEW_WIDGET_KEY, RANKING_WIDGET_KEY } from '../src/widgets.js';
import { BLOCKED_SERVICES_KEY, PAUSE_PROTECTION_KEY } from '../src/scene-actions.js';

const MAX_COVER_BYTES = 150 * 1024;
// The Gladys release that ships the dashboard widgets and scene actions.
const MIN_GLADYS_VERSION = '>=5.1.0';
// INTEGRATION_CATALOG_CATEGORIES in the core. The manifest schema has no enum
// (an unknown key is dropped with a warning), so a typo here would silently
// land the integration in the uncategorized bucket.
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const manifest = readJson('gladys-assistant-integration.json');
const pkg = readJson('package.json');
const configField = (key) => manifest.config_schema.find((entry) => entry.key === key);

test('the manifest version matches package.json and the image tag', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/cicoub13/gladys-adguard-home:${manifest.version}`);
});

test('the manifest is a device integration on the Gladys release that ships its capabilities', () => {
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, MIN_GLADYS_VERSION);
});

test('the name and descriptions fit the store limits', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} is ${text.length} chars`,
    );
  }
});

test('the catalog categories are declared and come from the core vocabulary', () => {
  assert.ok(manifest.categories?.length >= 1 && manifest.categories.length <= 3);
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category: ${category}`);
  }
});

test('no permission is requested that the integration does not use', () => {
  for (const key of ['location', 'network_wake', 'network_discovery', 'containers', 'webhooks']) {
    assert.equal(manifest[key], undefined, `${key} is declared but unused`);
  }
});

test('the password is a secret field, never a plain string', () => {
  assert.equal(configField('password').type, 'secret');
  assert.equal(configField('url').required, true);
});

test('the poll_frequency options and default are the ones the code accepts', () => {
  const field = configField('poll_frequency');
  assert.deepEqual(
    field.options.map((option) => Number(option.value)),
    POLL_FREQUENCY_OPTIONS,
  );
  assert.equal(Number(field.default), DEFAULT_CONFIG.poll_frequency);
});

test('the widget and scene action keys the code registers are the ones the manifest declares', () => {
  // The SDK routes every widget.get / scene-action.run by key: a key declared
  // here but registered under another name reaches no handler at all.
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    [OVERVIEW_WIDGET_KEY, RANKING_WIDGET_KEY],
  );
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key),
    [PAUSE_PROTECTION_KEY, BLOCKED_SERVICES_KEY],
  );
  assert.deepEqual(
    manifest.actions.map((action) => action.key),
    ['test_connection'],
  );
});

test('index.js registers a handler for every declared widget, scene action and action', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /onWidgetGet\(OVERVIEW_WIDGET_KEY/);
  assert.match(index, /onWidgetGet\(RANKING_WIDGET_KEY/);
  assert.match(index, /onWidgetAction\(OVERVIEW_WIDGET_KEY/);
  assert.match(index, /onSceneAction\(PAUSE_PROTECTION_KEY/);
  assert.match(index, /onSceneAction\(BLOCKED_SERVICES_KEY/);
  assert.match(index, /onAction\('test_connection'/);
});

test('every label shown to the user is translated (en + fr)', () => {
  const labeledEntries = [
    ...manifest.config_schema,
    ...manifest.actions,
    ...manifest.widgets.flatMap((widget) => [widget, ...(widget.settings ?? [])]),
    ...manifest.scene_actions.flatMap((action) => [action, ...action.fields, ...action.outputs]),
  ];
  const options = labeledEntries.flatMap((entry) => entry.options ?? []);

  for (const entry of [...labeledEntries, ...options]) {
    assert.ok(entry.label.en, `missing English label on ${JSON.stringify(entry)}`);
    assert.ok(entry.label.fr, `missing French label on ${JSON.stringify(entry)}`);
  }
});

test('widget labels fit the 3-30 characters the core accepts', () => {
  for (const widget of manifest.widgets) {
    for (const text of Object.values(widget.label)) {
      assert.ok(text.length >= 3 && text.length <= 30, `widget label "${text}"`);
    }
  }
});

test('the cover image points at a real file within the store limit', () => {
  assert.ok(manifest.cover_image.endsWith('/cover.png'));
  const size = statSync(new URL('../cover.png', import.meta.url)).size;
  assert.ok(size <= MAX_COVER_BYTES, `cover.png is ${size} bytes, over ${MAX_COVER_BYTES}`);
});
