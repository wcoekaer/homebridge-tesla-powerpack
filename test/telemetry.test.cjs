const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settings } = require('../dist/config');
const { makeView, TelemetryMonitor } = require('../dist/telemetry');
const { demoReadings } = require('../dist/demo');
const cfg = settings({ tokenFile: '/test/token', caFile: '/test/ca' });

test('missing, stale, and unsupported telemetry stays unknown rather than zero/healthy', () => {
  const empty = makeView({}, cfg);
  assert.equal(empty.soe, null); assert.equal(empty.health.equipmentFault, null); assert.equal(empty.health.charging, null);
  const now = Date.now(), data = demoReadings(now), stale = makeView(data, cfg, now + 91000);
  assert.equal(stale.soe, 82.9); assert.equal(stale.health.lowBattery, null); assert.equal(stale.health.islanded, null); assert.equal(stale.health.unreachable, true);
  assert.equal(stale.meters[0].fresh, false);
  delete data.status.value.battery_blocks[0].num_pods_faulted;
  assert.equal(makeView(data, cfg, now).health.equipmentFault, null);
});
test('embedded meter timestamps override a successful HTTP response', () => {
  const now = Date.now(), data = demoReadings(now);
  data.meters.value.battery.last_communication_time = new Date(now - 61000).toISOString();
  let view = makeView(data, cfg, now);
  assert.equal(view.fresh.meters, true); assert.equal(view.meters[0].fresh, false); assert.equal(view.health.discharging, null);
  data.meters.value.battery.last_communication_time = '0001-01-01T00:00:00Z';
  assert.equal(makeView(data, cfg, now).meters[0].fresh, false);
});
test('charging, discharging, idle and faults follow measured data', () => {
  const now = Date.now(), data = demoReadings(now);
  assert.equal(makeView(data, cfg, now).health.discharging, true);
  data.meters.value.battery.instant_power = -2000;
  let view = makeView(data, cfg, now); assert.equal(view.health.charging, true); assert.equal(view.health.discharging, false);
  data.meters.value.battery.instant_power = 50;
  view = makeView(data, cfg, now); assert.equal(view.health.charging, false); assert.equal(view.health.discharging, false);
  data.status.value.battery_blocks[0].num_pods_faulted = 1;
  assert.equal(makeView(data, cfg, now).health.equipmentFault, true);
  data.grid.value.grid_status = 'UnrecognizedState'; assert.equal(makeView(data, cfg, now).health.islanded, null);
});
test('low battery and arbitrary threshold contacts have recovery hysteresis', () => {
  const now = Date.now(), data = demoReadings(now);
  data.soe.value.percentage = 15;
  assert.equal(makeView(data, cfg, now).health.lowBattery, true);
  data.soe.value.percentage = 18;
  assert.equal(makeView(data, cfg, now, 0, [], true).health.lowBattery, true);
  data.soe.value.percentage = 20;
  let view = makeView(data, cfg, now, 0, [], true); assert.equal(view.health.lowBattery, false); assert.equal(view.thresholds['20'], true);
  data.soe.value.percentage = 21; assert.equal(makeView(data, cfg, now, 0, [], false, view.thresholds).thresholds['20'], true);
  data.soe.value.percentage = 22; assert.equal(makeView(data, cfg, now, 0, [], false, view.thresholds).thresholds['20'], false);
});
test('polls serialize; failed endpoints retain old timestamps; a failed status stops the cycle', async () => {
  const data = demoReadings(); let fail = '', calls = [], active = 0, maxActive = 0;
  const monitor = new TelemetryMonitor({ async read(key) {
    calls.push(key); active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 2)); active--;
    if (key === fail) throw new Error('Simulated unavailable'); return data[key].value;
  }, close() {} }, cfg);
  try {
    await Promise.all([monitor.poll(), monitor.poll()]); assert.equal(calls.length, 7); assert.equal(maxActive, 1);
    const at = monitor.view().readings.alerts.at; fail = 'alerts'; calls = []; await monitor.poll();
    assert.equal(monitor.view().readings.alerts.at, at); assert.match(monitor.view().readings.alerts.error, /unavailable/);
    assert.ok(!calls.includes('site'), 'site metadata only polls every five minutes');
    fail = 'status'; calls = []; await monitor.poll(); assert.deepEqual(calls, ['status']);
    assert.equal(monitor.view().history.at(-1).battery, null, 'a failed poll must not invent a new historical measurement');
  } finally { monitor.stop(); }
  await monitor.poll(); assert.deepEqual(calls, ['status']);
});
test('malformed successful responses cannot erase known telemetry or become fresh', async () => {
  const data = demoReadings(); let malformed = false;
  const monitor = new TelemetryMonitor({ async read(key) { return malformed ? {} : data[key].value; }, close() {} }, cfg);
  await monitor.poll(); const at = monitor.view().readings.status.at;
  malformed = true; await monitor.poll();
  assert.equal(monitor.view().readings.status.at, at); assert.ok(monitor.view().readings.status.error); monitor.stop();
});
