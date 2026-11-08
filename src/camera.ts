import type { CameraController, CameraStreamingDelegate, HAP, Logger, PrepareStreamCallback, PrepareStreamRequest, SnapshotRequest, SnapshotRequestCallback, StreamingRequest, StreamRequestCallback, VideoInfo } from 'homebridge' with { 'resolution-mode': 'import' };
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import dgram from 'node:dgram';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import type { Settings } from './config';
import type { DashboardRenderer } from './dashboard';

interface Session {
  socket: dgram.Socket; address: string; port: number; key: Buffer; salt: Buffer; ssrc: number;
  process?: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout; watchdog?: NodeJS.Timeout;
  startup?: NodeJS.Timeout; finishStart?: (error?: Error) => void;
  video?: VideoInfo; writing: boolean;
}

export function ffmpegPath(configured = ''): string {
  if (configured) return configured;
  try { const bundled: unknown = require('ffmpeg-for-homebridge'); if (typeof bundled === 'string' && existsSync(bundled)) return bundled; } catch { /* optional binary */ }
  return 'ffmpeg';
}

export class DashboardCamera implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private sessions = new Map<string, Session>();
  private closed = false;
  constructor(private readonly hap: HAP, private readonly renderer: DashboardRenderer, private readonly config: Settings['camera'], private readonly log: Pick<Logger, 'debug' | 'warn'>) {
    this.controller = new hap.CameraController({
      cameraStreamCount: config.maxStreams, delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: { profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH], levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0] },
          resolutions: [[320, 180, 15], [320, 240, 15], [640, 360, 15], [640, 480, 15], [1280, 720, 15], [1280, 720, 30], [1920, 1080, 15], [1920, 1080, 30]],
        },
      },
    });
  }
  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.renderer.render(request.width, request.height).then(image => callback(undefined, image), error => callback(error));
  }
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    if (this.closed || this.sessions.has(request.sessionID) || this.sessions.size >= this.config.maxStreams) return callback(new Error('No dashboard stream slots available'));
    if (!isIP(request.targetAddress) || !Number.isInteger(request.video.port) || request.video.port < 1 || request.video.port > 65535 || request.video.srtpCryptoSuite !== 0 || request.video.srtp_key.length !== 16 || request.video.srtp_salt.length !== 14) {
      return callback(new Error('Unsupported HomeKit video endpoint or encryption'));
    }
    const socket = dgram.createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    const session: Session = { socket, address: request.targetAddress, port: request.video.port, key: request.video.srtp_key, salt: request.video.srtp_salt, ssrc: this.hap.CameraController.generateSynchronisationSource(), writing: false };
    this.sessions.set(request.sessionID, session);
    let prepared = false;
    socket.on('error', error => {
      this.log.warn('Dashboard video socket failed: %s', error.message);
      this.stop(request.sessionID);
      if (!prepared) { prepared = true; callback(error); }
      else this.controller.forceStopStreamingSession(request.sessionID);
    });
    socket.on('message', (_message, remote) => {
      // HomeKit sends RTCP here. An abandoned viewer must not leave FFmpeg running.
      if (remote.address.replace(/^::ffff:/, '') === session.address.replace(/^::ffff:/, '')) this.armWatchdog(request.sessionID, session, 60000);
    });
    // The HomeKit control connection can use a different IP family (including
    // IPv4-mapped IPv6) from the negotiated video endpoint. Bind for video.
    socket.bind(0, request.addressVersion === 'ipv6' ? '::' : '0.0.0.0', () => {
      if (prepared || this.closed || !this.sessions.has(request.sessionID)) return;
      prepared = true;
      socket.unref();
      this.armWatchdog(request.sessionID, session, 30000);
      this.log.debug('Dashboard video prepared for %s:%s (%s)', request.targetAddress, request.video.port, request.addressVersion);
      callback(undefined, { video: { port: socket.address().port, ssrc: session.ssrc, srtp_key: session.key, srtp_salt: session.salt } });
    });
  }
  private armWatchdog(id: string, session: Session, ms: number): void {
    clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => { this.stop(id); this.controller.forceStopStreamingSession(id); }, ms);
    session.watchdog.unref();
  }
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === 'stop') { this.stop(request.sessionID); callback(); return; }
    const session = this.sessions.get(request.sessionID);
    if (!session) { callback(new Error('Unknown dashboard stream session')); return; }
    if (request.type === 'start') session.video = request.video;
    else {
      if (!session.video) { callback(new Error('Cannot reconfigure a stream before it starts')); return; }
      session.video = { ...session.video, ...request.video };
    }
    this.start(request.sessionID, session, callback);
  }
  private start(id: string, session: Session, callback: StreamRequestCallback): void {
    this.stopEncoder(session);
    const video = session.video!;
    if (![video.width, video.height, video.fps, video.max_bit_rate, video.pt, video.mtu].every(Number.isFinite) || video.width < 160 || video.width > 1920 || video.height < 90 || video.height > 1080 || video.fps < 1 || video.fps > 30 || video.max_bit_rate < 1 || video.max_bit_rate > 10000) {
      this.stop(id); callback(new Error('Invalid HomeKit video parameters')); return;
    }
    const width = Math.floor(video.width / 2) * 2, height = Math.floor(video.height / 2) * 2;
    const address = isIP(session.address) === 6 ? `[${session.address}]` : session.address;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', '5', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-i', 'pipe:0',
      '-an', '-sn', '-dn', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-profile:v', ['baseline', 'main', 'high'][video.profile] ?? 'baseline',
      '-level:v', ['3.1', '3.2', '4.0'][video.level] ?? '3.1', '-r', String(video.fps),
      '-g', String(video.fps * 2), '-b:v', `${video.max_bit_rate}k`, '-maxrate', `${video.max_bit_rate}k`, '-bufsize', `${video.max_bit_rate * 2}k`,
      '-payload_type', String(video.pt), '-ssrc', String(session.ssrc), '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', Buffer.concat([session.key, session.salt]).toString('base64'),
      `srtp://${address}:${session.port}?rtcpport=${session.port}&pkt_size=${Math.min(1316, Math.max(188, video.mtu))}`,
    ];
    const child = spawn(ffmpegPath(this.config.ffmpegPath), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.log.debug('Starting dashboard video: %sx%s at %s fps', width, height, video.fps);
    session.process = child;
    let called = false, stderr = '', progress = '';
    const ready = (error?: Error) => {
      if (!called) {
        called = true; clearTimeout(session.startup);
        if (session.finishStart === ready) session.finishStart = undefined;
        callback(error);
      }
    };
    session.finishStart = ready;
    session.startup = setTimeout(() => {
      const error = new Error('FFmpeg did not produce a dashboard frame in time');
      this.log.warn('%s', error.message); ready(error); this.stop(id);
      this.controller.forceStopStreamingSession(id);
    }, 12000);
    session.startup.unref();
    child.stdout.on('data', chunk => { progress = (progress + String(chunk)).slice(-1000); if (/frame=\s*[1-9]/.test(progress)) ready(); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1500); });
    child.on('error', () => {
      const error = new Error('Cannot start FFmpeg; install it or set camera.ffmpegPath');
      this.log.warn('%s', error.message); ready(error);
      if (session.process === child) { this.stop(id); this.controller.forceStopStreamingSession(id); }
    });
    child.on('close', code => {
      if (session.process !== child) return;
      if (!called || code) this.log.warn('Dashboard encoder stopped (%s): %s', code, stderr.replace(/(?:[A-Za-z0-9+/]{30,}={0,2})/g, '[redacted]').slice(-500));
      ready(new Error(`Dashboard encoder stopped (${code})`));
      this.stop(id); this.controller.forceStopStreamingSession(id);
    });
    child.stdin.on('error', () => { /* process close/error handler owns cleanup */ });
    const sendFrame = async () => {
      if (session.writing || session.process !== child || child.stdin.destroyed) return;
      session.writing = true;
      try {
        const jpeg = await this.renderer.render(width, height);
        if (session.process === child && !child.stdin.destroyed) child.stdin.write(jpeg, () => { if (session.process === child) session.writing = false; });
      } catch {
        if (session.process !== child) return;
        session.writing = false;
        const error = new Error('Dashboard rendering failed');
        this.log.warn('%s', error.message); ready(error); this.stop(id);
        this.controller.forceStopStreamingSession(id);
      }
    };
    void sendFrame();
    session.timer = setInterval(() => void sendFrame(), 200); session.timer.unref();
    this.armWatchdog(id, session, 60000);
  }
  private stopEncoder(session: Session): void {
    session.finishStart?.(new Error('Dashboard stream stopped before startup'));
    clearTimeout(session.startup); session.startup = undefined;
    clearInterval(session.timer); session.timer = undefined; session.writing = false;
    const child = session.process; session.process = undefined;
    if (child) {
      child.stdin.destroy(); child.kill('SIGTERM');
      const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      timeout.unref(); child.once('close', () => clearTimeout(timeout));
    }
  }
  stop(id: string): void {
    const session = this.sessions.get(id); if (!session) return;
    this.sessions.delete(id); clearTimeout(session.watchdog); this.stopEncoder(session);
    try { session.socket.close(); } catch { /* already closed */ }
  }
  shutdown(): void { this.closed = true; for (const id of this.sessions.keys()) this.stop(id); }
}
