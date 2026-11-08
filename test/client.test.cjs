const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockController } = require('./helpers.cjs');
const { PowerpackClient, ENDPOINTS } = require('../dist/client');

test('all seven reads use authenticated GET, no body, pinned CA, and the certificate hostname', async t => {
  const m = await mockController(t), client = new PowerpackClient(m.config); t.after(() => client.close());
  for (const key of Object.keys(ENDPOINTS)) await client.read(key);
  assert.equal(m.requests.length, 7);
  assert.deepEqual(m.requests.map(r => r.url), Object.values(ENDPOINTS));
  assert.ok(m.requests.every(r => r.method === 'GET' && !r.body && r.authorization === 'Bearer synthetic.test.token'));
  await assert.rejects(client.read('/api/reboot'), /allowlist/);
  await assert.rejects(client.read('__proto__'), /allowlist/);
  assert.equal(m.requests.length, 7, 'unknown endpoints never reach the network');
  client.close(); await assert.rejects(client.read('status'), /closed/);
});
test('wrong hostname fails TLS before sending credentials', async t => {
  const m = await mockController(t), client = new PowerpackClient({ ...m.config, servername: 'different.invalid' }); t.after(() => client.close());
  await assert.rejects(client.read('status'), /CERT_ALTNAME_INVALID/); assert.equal(m.requests.length, 0);
});
test('a redirect is rejected, never followed or forwarded credentials', async t => {
  const m = await mockController(t, (_req, res) => { res.writeHead(302, { Location: '/api/change-settings' }); res.end(); });
  const client = new PowerpackClient(m.config); t.after(() => client.close());
  await assert.rejects(client.read('status'), /HTTP 302/); assert.equal(m.requests.length, 1);
});
test('invalid JSON, authorization failure, and oversized responses are bounded and redact server content', async t => {
  let mode = 'json';
  const m = await mockController(t, (_req, res) => {
    if (mode === 'json') res.end('synthetic.test.token not json');
    else if (mode === 'denied') { res.writeHead(403); res.end('synthetic.test.token'); }
    else res.end(' '.repeat(2 * 1024 * 1024 + 1));
  });
  const client = new PowerpackClient(m.config); t.after(() => client.close());
  await assert.rejects(client.read('status'), /invalid JSON/);
  mode = 'denied'; await assert.rejects(client.read('status'), e => /HTTP 403/.test(e.message) && !e.message.includes('synthetic'));
  mode = 'large'; await assert.rejects(client.read('status'), /exceeds/);
});
test('stalled GET expires and client shutdown aborts in-flight reads', async t => {
  const m = await mockController(t, () => {}), client = new PowerpackClient({ ...m.config, timeoutSeconds: 1 }); t.after(() => client.close());
  await assert.rejects(client.read('status'), /timeout/);
  const read = client.read('status'); client.close(); await assert.rejects(read, /client is closed/);
});
