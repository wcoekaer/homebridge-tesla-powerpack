const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { settings } = require('../dist/config');
const { ENDPOINTS } = require('../dist/client');
const { demoReadings } = require('../dist/demo');

async function mockController(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'powerpack-test-'));
  const caFile = path.join(dir, 'ca.pem'), keyFile = path.join(dir, 'key.pem'), tokenFile = path.join(dir, 'token');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', caFile,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE', '-days', '1'], { stdio: 'ignore' });
  await fs.writeFile(tokenFile, 'synthetic.test.token\n', { mode: 0o600 });
  const requests = [], data = demoReadings();
  const server = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(caFile) }, async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (handler) return handler(req, res, data);
    const key = Object.keys(ENDPOINTS).find(k => ENDPOINTS[k] === req.url);
    if (!key) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data[key].value));
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = settings({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', tokenFile, caFile });
  const cleanup = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); };
  if (t) t.after(cleanup);
  return { dir, config, server, requests, data, cleanup };
}
const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 20)); }
};
module.exports = { mockController, waitFor };
