const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settings } = require('../dist/config');
const base = { tokenFile: '/test/token', caFile: '/test/ca' };
test('settings validate hosts, absolute credential paths, MQTT destinations and battery thresholds', () => {
  assert.equal(settings(base).port, 10443);
  assert.throws(() => settings({ ...base, host: 'https://example.com' }), /hostname/);
  assert.throws(() => settings({ ...base, tokenFile: 'relative' }), /absolute/);
  assert.throws(() => settings({ ...base, mqtt: { url: 'https://example.com' } }), /mqtt.url/);
  assert.throws(() => settings({ ...base, mqtt: { url: 'mqtt://user:secret@localhost' } }), /separate fields/);
  assert.throws(() => settings({ ...base, mqtt: { topicPrefix: 'tesla/#' } }), /topicPrefix/);
  assert.throws(() => settings({ ...base, batteryThresholds: [101] }), /batteryThresholds/);
  assert.throws(() => settings({ ...base, lowBatteryPercent: 30, lowBatteryRecoveryPercent: 20 }), /exceed/);
  assert.throws(() => settings({ ...base, pollIntervalSeconds: 100, staleAfterSeconds: 90 }), /twice/);
  assert.deepEqual(settings({ ...base, batteryThresholds: [50, 20, 50] }).batteryThresholds, [20, 50]);
});
