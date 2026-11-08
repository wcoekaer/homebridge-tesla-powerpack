import https from 'node:https';
import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import type { ClientRequest } from 'node:http';
import type { Settings } from './config';

/** The complete network surface. No generic URL, write method, or login operation exists. */
export const ENDPOINTS = Object.freeze({
  status: '/api/system_status', soe: '/api/system_status/soe',
  meters: '/api/meters/aggregates', grid: '/api/system_status/grid_status',
  gridFaults: '/api/system_status/grid_faults', alerts: '/api/alerts', site: '/api/site_info',
} as const);
export type Endpoint = keyof typeof ENDPOINTS;
export interface ReadOnlySource { read(endpoint: Endpoint): Promise<unknown>; close(): void }

export class PowerpackClient implements ReadOnlySource {
  #token: string;
  #ca: Buffer;
  #closed = false;
  #requests = new Set<ClientRequest>();
  #agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  constructor(private readonly config: Pick<Settings, 'host' | 'port' | 'servername' | 'tokenFile' | 'caFile' | 'timeoutSeconds'>) {
    try { this.#token = readFileSync(config.tokenFile, 'utf8').trim().replace(/^Bearer\s+/i, ''); }
    catch { throw new Error('Cannot read tokenFile; check its path and Homebridge file permissions'); }
    if (!/^[A-Za-z0-9_.~+\/-]+=*$/.test(this.#token) || this.#token.length > 16384) throw new Error('tokenFile must contain a single bearer token');
    try { this.#ca = readFileSync(config.caFile); }
    catch { throw new Error('Cannot read caFile; check its path and Homebridge file permissions'); }
    if (!this.#ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('caFile must contain Tesla’s PEM CA certificate');
  }
  read(endpoint: Endpoint): Promise<unknown> {
    if (!Object.hasOwn(ENDPOINTS, endpoint)) return Promise.reject(new Error('Endpoint is not in the telemetry GET allowlist'));
    if (this.#closed) return Promise.reject(new Error('Telemetry client is closed'));
    const path = ENDPOINTS[endpoint];
    return new Promise((resolve, reject) => {
      let completed = false, request: ClientRequest | undefined, timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, data?: unknown) => {
        if (completed) return;
        completed = true; clearTimeout(timer);
        if (request) this.#requests.delete(request);
        error ? reject(error) : resolve(data);
      };
      try {
        request = https.request({
          hostname: this.config.host, port: this.config.port, path, method: 'GET',
          servername: isIP(this.config.servername) ? undefined : this.config.servername,
          ca: this.#ca, rejectUnauthorized: true,
          checkServerIdentity: (_name, cert) => checkServerIdentity(this.config.servername, cert),
          agent: this.#agent,
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', 'User-Agent': 'homebridge-tesla-powerpack/0.1.0' },
        }, response => {
          if (response.statusCode !== 200) {
            finish(new Error(`GET ${path}: HTTP ${response.statusCode ?? 'unknown'}${response.statusCode === 403 ? ' (token lacks permission)' : ''}`));
            response.destroy(); return; // Never follow redirects or run authentication exchanges.
          }
          const chunks: Buffer[] = []; let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) { finish(new Error(`GET ${path}: response exceeds 2 MiB`)); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('error', () => finish(new Error(`GET ${path}: incomplete response`)));
          response.on('end', () => {
            if (completed) return;
            try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { finish(new Error(`GET ${path}: invalid JSON response`)); }
          });
        });
        this.#requests.add(request);
        timer = setTimeout(() => {
          finish(new Error(`GET ${path}: timeout`)); request?.destroy();
        }, this.config.timeoutSeconds * 1000);
        request.on('error', (error: NodeJS.ErrnoException) => {
          if (this.#closed) { finish(new Error('Telemetry client is closed')); return; }
          // Do not log request options, headers, raw error messages, or response bodies.
          const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'CONNECTION_ERROR';
          finish(new Error(`GET ${path}: ${code}`));
        });
        request.end(); // No request body is ever sent.
      } catch { finish(new Error(`GET ${path}: TLS/request initialization failed`)); }
    });
  }
  close(): void {
    this.#closed = true;
    for (const request of this.#requests) request.destroy(new Error('Telemetry client closed'));
    this.#requests.clear(); this.#agent.destroy();
  }
}
