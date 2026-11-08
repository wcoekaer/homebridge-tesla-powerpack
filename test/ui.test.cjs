const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { mockController } = require('./helpers.cjs');
const { storeCredentials } = require('../homebridge-ui/credentials');
const vm = require('node:vm');

test('credential uploads validate PEM, store private files, and never return the token', async t => {
  const m = await mockController(t), pem = await fs.readFile(m.config.caFile, 'utf8');
  const stored = await storeCredentials(m.dir, { token: 'secret.for.this.test', pem, filename: '../../overwrite' });
  assert.ok(stored.tokenFile.startsWith(path.join(m.dir, 'tesla-powerpack')));
  assert.equal((await fs.stat(stored.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(stored.tokenFile))).mode & 0o777, 0o700);
  assert.equal((await fs.readFile(stored.tokenFile, 'utf8')).trim(), 'secret.for.this.test');
  assert.ok(!JSON.stringify(stored).includes('secret.for.this.test'));
  await assert.rejects(storeCredentials(m.dir, { pem: pem + '\n-----BEGIN PRIVATE KEY-----', token: 'token' }), /private key/);
  await assert.rejects(storeCredentials(m.dir, { pem: 'bad', token: 'token' }), /valid X.509/);
  await assert.rejects(storeCredentials(m.dir, { pem, token: 'bad\nHeader: injected' }), /one bearer/);
  const replacement = await storeCredentials(m.dir, { pem, token: 'replacement' });
  assert.notEqual(replacement.tokenFile, stored.tokenFile);
  assert.equal((await fs.readFile(stored.tokenFile, 'utf8')).trim(), 'secret.for.this.test', 'replacement cannot overwrite an in-use pair');
});
test('real Homebridge UI server accepts upload and GET probe over its IPC API', { timeout: 10000 }, async t => {
  const m = await mockController(t), child = fork(path.resolve(__dirname, '../homebridge-ui/server.js'), [], {
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: m.dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  await new Promise((resolve, reject) => { child.on('message', message => { if (message.action === 'ready') resolve(); }); child.once('error', reject); });
  let id = 0;
  const request = (route, body) => new Promise(resolve => {
    const requestId = ++id;
    const receive = message => { if (message.payload?.requestId === requestId) { child.off('message', receive); resolve(message.payload); } };
    child.on('message', receive); child.send({ action: 'request', path: route, body, requestId });
  });
  const saved = await request('/credentials', { pem: await fs.readFile(m.config.caFile, 'utf8'), token: 'synthetic.test.token' });
  assert.equal(saved.success, true);
  const probe = await request('/probe', { ...m.config, ...saved.data });
  assert.equal(probe.success, true); assert.equal(probe.data.blocks, 1);
  assert.equal(m.requests.length, 1); assert.equal(m.requests[0].method, 'GET');
  assert.ok(!output.includes('synthetic.test.token'));
});

test('setup screen stages uploaded paths, preserves child-bridge/MQTT settings, and never puts file contents into config', async () => {
  const elements = Object.fromEntries(['pp-status', 'pp-upload', 'pp-test', 'pp-pem', 'pp-token'].map(id => [id, {
    files: [], value: '', disabled: false, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; },
  }]));
  elements['pp-pem'].files = [{ size: 100, text: async () => 'certificate-content' }];
  elements['pp-token'].files = [{ size: 100, text: async () => 'private-token-content' }];
  let config = [{ platform: 'TeslaPowerpack', host: '192.0.2.42', _bridge: { username: '02:00:00:00:00:01' }, mqtt: { enabled: true, url: 'mqtt://broker:1883' } }];
  let formShown = false, tested;
  const hb = {
    getPluginConfig: async () => structuredClone(config),
    updatePluginConfig: async value => { config = structuredClone(value); },
    showSchemaForm: () => { formShown = true; },
    request: async (route, payload) => {
      if (route === '/credentials') { assert.equal(payload.token, 'private-token-content'); return { tokenFile: '/storage/token', caFile: '/storage/ca.pem' }; }
      assert.equal(route, '/probe'); tested = payload; return { ok: true, blocks: 1, state: 'SystemIslandedActive' };
    },
  };
  await vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../homebridge-ui/public/setup.js'), 'utf8'), {
    window: { homebridge: hb }, document: { getElementById: id => elements[id] },
  });
  assert.equal(formShown, true);
  await elements['pp-upload'].handlers.click();
  assert.equal(config[0].tokenFile, '/storage/token'); assert.equal(config[0].host, '192.0.2.42');
  assert.equal(config[0]._bridge.username, '02:00:00:00:00:01'); assert.equal(config[0].mqtt.enabled, true);
  assert.ok(!JSON.stringify(config).includes('private-token-content'));
  assert.equal(elements['pp-token'].value, '');
  await elements['pp-test'].handlers.click();
  assert.equal(tested.tokenFile, '/storage/token'); assert.match(elements['pp-status'].textContent, /GET succeeded/);
});
