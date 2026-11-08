import mqtt, { type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Settings } from './config';
import { ENDPOINTS, type Endpoint } from './client';
import { number, record, string, type View } from './telemetry';

export function exportState(view: View): Record<string, unknown> {
  const n = (key: string) => view.fresh.status ? number(view.status[key]) : null;
  return {
    schemaVersion: 1, observedAt: view.readings.status?.at ? new Date(view.readings.status.at).toISOString() : null,
    exportedAt: new Date(view.now).toISOString(), available: !view.health.unreachable,
    stateOfEnergyPercent: view.fresh.soe ? view.soe : null,
    energyRemainingWh: n('nominal_energy_remaining'), nominalFullPackEnergyWh: n('nominal_full_pack_energy'),
    maxChargePowerW: n('max_charge_power'), maxDischargePowerW: n('max_discharge_power'),
    gridState: view.fresh.grid || view.fresh.status ? view.gridState : null, health: view.health, batteryThresholds: view.thresholds,
    meters: Object.fromEntries(view.meters.map(m => [m.name, {
      fresh: m.fresh, observedAt: m.at ? new Date(m.at).toISOString() : null,
      powerW: m.fresh ? m.power : null, reactivePowerVar: m.fresh ? m.reactive : null, apparentPowerVA: m.fresh ? m.apparent : null,
      voltageV: m.fresh ? m.voltage : null, currentA: m.fresh ? m.current : null, frequencyHz: m.fresh ? m.frequency : null,
      energyImportedWh: m.fresh ? m.imported : null, energyExportedWh: m.fresh ? m.exported : null,
    }])),
    blocks: view.fresh.status ? view.blocks : null,
    alerts: view.fresh.alerts ? view.alerts : null, gridFaults: view.fresh.gridFaults ? view.gridFaults : null,
    firmware: view.fresh.site ? string(record(view.site.firmware).version) || null : null,
    endpoints: Object.fromEntries((Object.keys(ENDPOINTS) as Endpoint[]).map(k => [k, {
      fresh: view.fresh[k], observedAt: view.readings[k]?.at ? new Date(view.readings[k]!.at!).toISOString() : null,
      error: view.readings[k]?.error ?? null,
    }])),
  };
}

/** Publish-only: no subscriptions, message handlers, or connection to control operations. */
export class TelemetryPublisher {
  private client?: MqttClient;
  private latest?: View;
  private lastSignature = '';
  private sending = false;
  private stopped = false;
  private lastWarning = 0;
  constructor(private readonly config: Settings, private readonly log: { info(...args: any[]): void; warn(...args: any[]): void }) {}
  start(): void {
    if (!this.config.mqtt.enabled || this.client || this.stopped) return;
    const c = this.config.mqtt;
    let ca: Buffer | undefined;
    if (c.caFile) { try { ca = readFileSync(c.caFile); } catch { this.log.warn('MQTT disabled: cannot read mqtt.caFile'); return; } }
    const id = c.clientId || `powerpack-${createHash('sha256').update(`${this.config.host}:${this.config.port}:${c.topicPrefix}`).digest('hex').slice(0, 12)}`;
    this.client = mqtt.connect(c.url, {
      clientId: id, username: c.username || undefined, password: c.password || undefined,
      ca, rejectUnauthorized: true, connectTimeout: 5000, reconnectPeriod: 5000, reconnectOnConnackError: true,
      queueQoSZero: false, clean: true, resubscribe: false, keepalive: 30,
      will: { topic: `${c.topicPrefix}/availability`, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    this.client.on('connect', () => { this.log.info('MQTT telemetry publisher connected'); this.lastSignature = ''; if (this.latest) this.update(this.latest); });
    this.client.on('error', () => {
      if (Date.now() - this.lastWarning > 60000) { this.lastWarning = Date.now(); this.log.warn('MQTT export unavailable; check broker address, credentials, and TLS trust. Controller polling continues.'); }
    });
    this.client.on('close', () => { this.lastSignature = ''; });
  }
  update(view: View): void {
    this.latest = view;
    if (this.stopped || !this.client?.connected || this.sending) return;
    const signature = JSON.stringify([view.revision, view.fresh, view.meters.map(m => m.fresh), view.health, view.thresholds]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature; this.sending = true;
    const c = this.config.mqtt;
    const messages: [string, string, boolean][] = [
      ['availability', view.health.unreachable ? 'offline' : 'online', true],
      ['state', JSON.stringify(exportState(view)), c.retain],
    ];
    if (c.raw) for (const key of Object.keys(ENDPOINTS) as Endpoint[]) {
      const reading = view.readings[key];
      messages.push([`raw/${key}`, JSON.stringify({ endpoint: ENDPOINTS[key], fresh: view.fresh[key],
        observedAt: reading?.at ? new Date(reading.at).toISOString() : null, error: reading?.error ?? null, data: reading?.value ?? null }), c.retain]);
    }
    void (async () => {
      try {
        for (const [topic, body, retain] of messages) {
          if (this.stopped || !this.client?.connected) break;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('MQTT publish timeout')), 5000);
            this.client!.publish(`${c.topicPrefix}/${topic}`, body, { qos: 0, retain }, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
          });
        }
      } catch { this.lastSignature = ''; }
      finally { this.sending = false; }
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    if (!client) return;
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); client.end(true); resolve(); };
      const timer = setTimeout(finish, 1500);
      if (client.connected) client.publish(`${this.config.mqtt.topicPrefix}/availability`, 'offline', { qos: 0, retain: true }, finish);
      else finish();
    });
  }
}
