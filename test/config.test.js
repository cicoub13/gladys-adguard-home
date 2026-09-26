import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, normalizeUrl } from '../src/config.js';

test('an empty or null configuration falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.equal(isConfigured(normalizeConfig(null)), false);
});

test('a complete configuration is kept, with the frequency coerced to a number', () => {
  const config = normalizeConfig({
    url: ' https://adguard.example.com ',
    username: ' admin ',
    password: ' spaces are part of a password ',
    poll_frequency: '30',
  });
  assert.deepEqual(config, {
    url: 'https://adguard.example.com',
    username: 'admin',
    password: ' spaces are part of a password ',
    poll_frequency: 30,
  });
  assert.equal(isConfigured(config), true);
});

test('a frequency outside the manifest options snaps back to the default', () => {
  assert.equal(normalizeConfig({ poll_frequency: '5' }).poll_frequency, 60);
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, 60);
  assert.equal(normalizeConfig({ poll_frequency: 300 }).poll_frequency, 300);
});

test('the address is normalized to a base URL the client can append /control to', () => {
  assert.equal(normalizeUrl('192.168.1.10:3000'), 'http://192.168.1.10:3000');
  assert.equal(normalizeUrl('http://192.168.1.10:3000/'), 'http://192.168.1.10:3000');
  assert.equal(normalizeUrl('https://example.com/adguard/'), 'https://example.com/adguard');
  assert.equal(normalizeUrl('https://example.com/control/'), 'https://example.com');
  assert.equal(normalizeUrl('HTTPS://Example.com'), 'https://example.com');
});

test('unusable addresses are rejected rather than half-parsed', () => {
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('   '), '');
  assert.equal(normalizeUrl(42), '');
  assert.equal(normalizeUrl('ftp://example.com'), '');
  assert.equal(normalizeUrl('http://'), '');
  // Credentials belong in their own fields, never in a URL that gets logged.
  assert.equal(normalizeUrl('http://admin:secret@192.168.1.10'), '');
});
