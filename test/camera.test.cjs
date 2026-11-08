const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { DashboardCamera, ffmpegPath } = require('../dist/camera');
const { DashboardRenderer } = require('../dist/dashboard');
const { demoReadings } = require('../dist/demo');
const { settings } = require('../dist/config');
const { makeView } = require('../dist/telemetry');
const config = { enabled: true, name: 'Test', ffmpegPath: '', maxStreams: 2 };
const log = { debug() {}, warn() {} };
const request = (port, sessionID = crypto.randomUUID()) => ({ sessionID, sourceAddress: '127.0.0.1', targetAddress: '127.0.0.1', addressVersion: 'ipv4', video: { port, srtpCryptoSuite: 0, srtp_key: crypto.randomBytes(16), srtp_salt: crypto.randomBytes(14) } });
const prepare = (camera, req) => new Promise((resolve, reject) => camera.prepareStream(req, (e, response) => e ? reject(e) : resolve(response)));
const stream = (camera, req) => new Promise((resolve, reject) => camera.handleStreamRequest(req, e => e ? reject(e) : resolve()));
const renderer = () => new DashboardRenderer(() => { const now = Date.now(); return makeView(demoReadings(now), settings({ tokenFile: '/test/token', caFile: '/test/ca' }), now, 1); });

test('IPv4 video works when the HomeKit TCP connection has an IPv4-mapped IPv6 address', { timeout: 5000 }, async t => {
  const hap = await import('@homebridge/hap-nodejs');
  const camera = new DashboardCamera(hap, renderer(), config, log); t.after(() => camera.shutdown());
  const req = { ...request(45000), sourceAddress: '::ffff:127.0.0.1' };
  const response = await prepare(camera, req);
  assert.ok(response.video.port > 0);
});

test('video and HomeKit control connections may use different IP families', { timeout: 5000 }, async t => {
  const hap = await import('@homebridge/hap-nodejs');
  const camera = new DashboardCamera(hap, renderer(), config, log); t.after(() => camera.shutdown());
  const req = { ...request(45000), sourceAddress: '::1' };
  const response = await prepare(camera, req);
  assert.ok(response.video.port > 0);
});

test('dashboard camera sends encrypted RTP, supports reconfiguration, and cleans up', { timeout: 25000 }, async t => {
  const hap = await import('@homebridge/hap-nodejs');
  const camera = new DashboardCamera(hap, renderer(), config, log); t.after(() => camera.shutdown());
  const receiver = dgram.createSocket('udp4'); await new Promise(resolve => receiver.bind(0, '127.0.0.1', resolve)); t.after(() => receiver.close());
  const packets = []; receiver.on('message', p => packets.push(p));
  const req = request(receiver.address().port), response = await prepare(camera, req);
  assert.ok(response.video.port); assert.equal(response.video.srtp_key.length, 16);
  const video = { width: 640, height: 360, fps: 15, pt: 99, mtu: 1316, profile: 0, level: 0, max_bit_rate: 300, rtcp_interval: 0.5, codec: 0, packetizationMode: 0, ssrc: 1 };
  await stream(camera, { sessionID: req.sessionID, type: 'start', video });
  assert.ok(packets.some(p => p.length > 20 && p[0] >> 6 === 2 && (p[1] & 127) === 99), 'HomeKit SRTP video packets received');
  await stream(camera, { sessionID: req.sessionID, type: 'reconfigure', video: { width: 320, height: 180, fps: 15, max_bit_rate: 200, rtcp_interval: 0.5 } });
  await stream(camera, { sessionID: req.sessionID, type: 'stop' });
  assert.equal(camera.sessions.size, 0);
});
test('missing FFmpeg returns an error and releases the prepared session', { timeout: 15000 }, async t => {
  const hap = await import('@homebridge/hap-nodejs');
  const warnings = [];
  const camera = new DashboardCamera(hap, renderer(), { ...config, ffmpegPath: '/nonexistent/powerpack-ffmpeg' }, { ...log, warn: (...args) => warnings.push(args.join(' ')) }); t.after(() => camera.shutdown());
  const req = request(45000); await prepare(camera, req);
  await assert.rejects(stream(camera, { sessionID: req.sessionID, type: 'start', video: { width: 640, height: 360, fps: 15, pt: 99, mtu: 1316, profile: 0, level: 0, max_bit_rate: 300 } }), /FFmpeg/);
  assert.equal(camera.sessions.size, 0);
  assert.ok(warnings.some(message => message.includes('Cannot start FFmpeg')), 'startup failure is visible without debug logging');
});

test('the encrypted camera feed decrypts and decodes to a dashboard image', { timeout: 20000 }, async t => {
  const hap = await import('@homebridge/hap-nodejs');
  const camera = new DashboardCamera(hap, renderer(), config, log); t.after(() => camera.shutdown());
  const reservation = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.bind(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const req = { ...request(port), sourceAddress: '::ffff:127.0.0.1' }; await prepare(camera, req);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'powerpack-srtp-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sdp = path.join(temp, 'video.sdp');
  await fs.writeFile(sdp, [
    'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Dashboard test', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=video ${port} RTP/SAVP 99`, 'a=rtpmap:99 H264/90000', 'a=fmtp:99 packetization-mode=1',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${Buffer.concat([req.video.srtp_key, req.video.srtp_salt]).toString('base64')}`, '',
  ].join('\n'), { mode: 0o600 });
  const decoder = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,crypto,udp,rtp', '-analyzeduration', '0', '-probesize', '32768', '-i', sdp, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  t.after(() => decoder.kill('SIGKILL'));
  const chunks = []; let errors = '';
  decoder.stdout.on('data', data => chunks.push(data)); decoder.stderr.on('data', data => { errors += String(data); });
  const decoded = new Promise((resolve, reject) => { decoder.once('error', reject); decoder.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Decoder: ${errors}`))); });
  await new Promise(resolve => setTimeout(resolve, 250));
  await stream(camera, { sessionID: req.sessionID, type: 'start', video: { width: 640, height: 360, fps: 15, pt: 99, mtu: 1200, profile: 0, level: 0, max_bit_rate: 500 } });
  const image = await decoded;
  const meta = await sharp(image).metadata();
  assert.equal(meta.width, 640); assert.equal(meta.height, 360);
  assert.ok(image.length > 10000, 'Decoded frame contains the graphic, not a blank placeholder');
});
