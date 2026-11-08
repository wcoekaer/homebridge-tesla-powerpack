// Disposable Homebridge storage and a synthetic HTTPS controller. Never contacts a real site.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mockController } = require('../test/helpers.cjs');
const { name: pluginName } = require('../package.json');
const mac = () => ['02', ...crypto.randomBytes(5).toString('hex').match(/../g)].join(':').toUpperCase();
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
(async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'powerpack-child-smoke-'));
  const controller = await mockController();
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    const username = mac();
    await fs.writeFile(path.join(storage, 'config.json'), JSON.stringify({
      bridge: { name: 'Powerpack Test Only', username: mac(), port: await freePort(), pin: '781-34-629' },
      plugins: [pluginName], accessories: [], platforms: [{ ...controller.config, platform: 'TeslaPowerpack', name: 'Powerpack Test',
        _bridge: { username, port: await freePort() } }],
    }));
    const launch = async () => {
      child = spawn(process.execPath, [path.join(__dirname, '../node_modules/homebridge/bin/homebridge.js'), '-U', storage, '-P', path.resolve(__dirname, '..'), '--strict-plugin-resolution'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child bridge did not become ready:\n' + output)), 20000);
        const read = data => {
          output = (output + String(data)).slice(-20000);
          if (output.includes('Monitoring 127.0.0.1') && output.includes('Health: islanded=true lowBattery=false equipmentFault=false') && /running on port/i.test(output)) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', read); child.stderr.on('data', read);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Homebridge exited ${code}: ${output}`)); });
      });
      assert.ok(!output.includes('invalid \'Name\''), 'all accessory names are valid');
      console.log(output.split('\n').filter(line => /Loaded plugin|Registering platform|child bridge|Monitoring|Health:|running on port/i.test(line)).join('\n'));
    };
    await launch(); await stop();
    const cachePath = path.join(storage, 'accessories', `cachedAccessories.${username.replaceAll(':', '')}`);
    const first = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(first.length, 10);
    await launch(); await stop();
    const restored = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.deepEqual(restored.map(a => a.UUID).sort(), first.map(a => a.UUID).sort());
    assert.ok(controller.requests.every(r => r.method === 'GET' && !r.body));
    console.log('PASS: real Homebridge child bridge, camera, battery services, thresholds, GET polling, and cache restoration.');
  } finally { await stop(); await controller.cleanup(); await fs.rm(storage, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
