const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { settings } = require('../dist/config');
const { demoReadings } = require('../dist/demo');
const { makeView } = require('../dist/telemetry');
const { DashboardRenderer, dashboardSvg } = require('../dist/dashboard');
const config = settings({ tokenFile: '/test/token', caFile: '/test/ca' });

test('snapshot is a real JPEG with schematic pods, escaped text, and unavailable data labels', async () => {
  const now = Date.now(), data = demoReadings(now);
  data.alerts.value[0].name = '<script>alert("bad")</script>';
  const view = makeView(data, config, now);
  const svg = dashboardSvg(view, '<Site>');
  assert.ok(svg.includes('&lt;Site&gt;')); assert.ok(!svg.includes('<script>'));
  assert.match(svg, /Individual pod temperatures/); assert.match(svg, /INVERTERS/);
  const jpg = await new DashboardRenderer(() => view).render(1280, 720);
  const meta = await sharp(jpg).metadata(); assert.equal(meta.width, 1280); assert.equal(meta.height, 720); assert.equal(meta.format, 'jpeg');
  assert.ok(jpg.length > 30000);
  assert.match(dashboardSvg(makeView({}, config)), /UNAVAILABLE/);
  assert.match(dashboardSvg(makeView(data, config, now + 91000)), /TELEMETRY STALE/);
});
