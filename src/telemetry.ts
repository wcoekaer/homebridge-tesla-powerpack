import { EventEmitter } from 'node:events';
import { ENDPOINTS, type Endpoint, type ReadOnlySource } from './client';
import type { Settings } from './config';

export type Wire = Record<string, unknown>;
export const record = (value: unknown): Wire => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Wire : {};
export const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15 ? value : null;
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export interface Reading { value?: unknown; at?: number; error?: string }
export type Readings = Partial<Record<Endpoint, Reading>>;
export interface Block {
  id: string; serial: string; part: string; firmware: string; states: string[]; state: string;
  pods: number | null; podFaults: number | null; inverters: number | null; inverterFaults: number | null;
  fault: string; limited: string; disabled: string; selfTest: string;
}
export interface Meter {
  name: string; power: number | null; reactive: number | null; apparent: number | null;
  voltage: number | null; current: number | null; frequency: number | null;
  imported: number | null; exported: number | null; at: number | null; fresh: boolean;
}
export interface Alert { name: string; detail: string; device: number | null }
export interface Point { at: number; battery: number | null; solar: number | null; soe: number | null }
export interface Health { islanded: boolean | null; lowBattery: boolean | null; equipmentFault: boolean | null; unreachable: boolean; charging: boolean | null; discharging: boolean | null }
export interface View {
  now: number; revision: number; readings: Readings; fresh: Record<Endpoint, boolean>;
  status: Wire; blocks: Block[]; meters: Meter[]; alerts: Alert[]; gridFaults: unknown[] | null;
  soe: number | null; gridState: string; site: Wire; history: Point[]; health: Health;
  thresholds: Record<string, boolean | null>;
}
export const endpointFresh = (readings: Readings, key: Endpoint, now: number, staleMs: number): boolean =>
  readings[key]?.at !== undefined && now - readings[key]!.at! <= (key === 'site' ? Math.max(3600000, staleMs) : staleMs);

/** Validate shape before marking a response fresh. Missing individual fields remain unknown. */
export function validate(endpoint: Endpoint, value: unknown): void {
  if (endpoint === 'alerts' || endpoint === 'gridFaults') {
    if (!Array.isArray(value)) throw new Error(`GET ${ENDPOINTS[endpoint]}: expected a JSON array`);
  } else {
    const obj = record(value);
    if (!Object.keys(obj).length || 'error' in obj) throw new Error(`GET ${ENDPOINTS[endpoint]}: unexpected response shape`);
    if (endpoint === 'status' && !('battery_blocks' in obj || 'nominal_energy_remaining' in obj || 'system_island_state' in obj)) throw new Error('Status response has no recognized telemetry fields');
    if (endpoint === 'soe' && (number(obj.percentage) === null || Number(obj.percentage) < 0 || Number(obj.percentage) > 100)) throw new Error('State-of-energy percentage is unavailable');
  }
}

export function makeView(readings: Readings, config: Settings, now = Date.now(), revision = 0, history: Point[] = [], previousLow = false, previousThresholds: Record<string, boolean | null> = {}): View {
  const fresh = Object.fromEntries((Object.keys(ENDPOINTS) as Endpoint[]).map(k => [k, endpointFresh(readings, k, now, config.staleAfterSeconds * 1000)])) as Record<Endpoint, boolean>;
  const status = record(readings.status?.value), site = record(readings.site?.value);
  const blocks = (Array.isArray(status.battery_blocks) ? status.battery_blocks : []).map(value => {
    const b = record(value);
    return { id: string(b.id), serial: string(b.package_serial_number), part: string(b.package_part_number), firmware: string(b.fw_version),
      states: (Array.isArray(b.states) ? b.states : []).filter((s): s is string => typeof s === 'string'), state: string(b.opState),
      pods: number(b.num_pods_reported), podFaults: number(b.num_pods_faulted), inverters: number(b.num_tinv_connected), inverterFaults: number(b.num_tinv_faulted),
      fault: string(b.faulted_reason), limited: string(b.power_limited_reason), disabled: Array.isArray(b.disabled_reasons) ? b.disabled_reasons.map(String).join(', ') : string(b.disabled_reasons), selfTest: string(record(b.self_test_status).state),
    };
  });
  const meters = Object.entries(record(readings.meters?.value)).map(([name, value]) => {
    const m = record(value), date = Date.parse(string(m.last_communication_time));
    const at = Number.isFinite(date) && date > 0 ? date : null;
    const timeoutMs = number(m.timeout) === null ? config.staleAfterSeconds * 1000 : Math.max(0, Number(m.timeout) / 1e6);
    return { name, power: number(m.instant_power), reactive: number(m.instant_reactive_power), apparent: number(m.instant_apparent_power), voltage: number(m.instant_average_voltage),
      current: number(m.instant_total_current) ?? number(m.instant_average_current), frequency: number(m.frequency), imported: number(m.energy_imported), exported: number(m.energy_exported), at,
      fresh: fresh.meters && at !== null && at <= now + 5000 && now - at <= Math.min(timeoutMs, config.staleAfterSeconds * 1000),
    };
  });
  const soe = number(record(readings.soe?.value).percentage);
  const gridState = fresh.grid ? string(record(readings.grid?.value).grid_status) : string(status.system_island_state);
  const gridFresh = fresh.grid || fresh.status;
  const islanded = !gridFresh ? null : /^SystemIslanded/.test(gridState) ? true : gridState === 'SystemGridConnected' ? false : null;
  let equipmentFault: boolean | null = null;
  if (fresh.status) {
    if (number(status.available_blocks) === 0 || blocks.some(b => (b.podFaults ?? 0) > 0 || (b.inverterFaults ?? 0) > 0 || !!b.fault || b.states.some(s => /^(faulted|fault)$/i.test(s)))) equipmentFault = true;
    else if (blocks.length && blocks.every(b => b.podFaults === 0 && b.inverterFaults === 0 && b.states.includes('OK'))) equipmentFault = false;
  }
  const lowBattery = !fresh.soe || soe === null ? null : previousLow ? soe < config.lowBatteryRecoveryPercent : soe <= config.lowBatteryPercent;
  const battery = meters.find(m => m.name === 'battery');
  const power = battery?.fresh ? battery.power : null;
  const thresholds = Object.fromEntries(config.batteryThresholds.map(threshold => [String(threshold), !fresh.soe || soe === null ? null : previousThresholds[String(threshold)] ? soe < Math.min(100, threshold + 2) : soe <= threshold]));
  const alerts = (Array.isArray(readings.alerts?.value) ? readings.alerts.value : []).map(value => {
    const a = record(value);
    return { name: string(a.name) || 'Unnamed alert', detail: string(a.data), device: number(a.sub_device) };
  });
  return { now, revision, readings, fresh, status, blocks, meters, alerts, soe, gridState, site, history,
    gridFaults: Array.isArray(readings.gridFaults?.value) ? readings.gridFaults.value : null,
    thresholds,
    health: { islanded, lowBattery, equipmentFault, unreachable: !fresh.status,
      charging: power == null ? null : power < -config.powerActivityThresholdWatts,
      discharging: power == null ? null : power > config.powerActivityThresholdWatts },
  };
}

export class TelemetryMonitor extends EventEmitter {
  private readings: Readings = {};
  private history: Point[] = [];
  private meterTimes = new Map<string, number>();
  private revision = 0;
  private low = false;
  private thresholds: Record<string, boolean | null> = {};
  private polling?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private pulse?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  constructor(private readonly source: ReadOnlySource, private readonly config: Settings) { super(); }
  view(now = Date.now()): View {
    const view = makeView(this.readings, this.config, now, this.revision, this.history, this.low, this.thresholds);
    if (view.health.lowBattery !== null) this.low = view.health.lowBattery;
    for (const [key, value] of Object.entries(view.thresholds)) if (value !== null) this.thresholds[key] = value;
    return view;
  }
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.pulse = setInterval(() => this.emit('update', this.view()), 1000); this.pulse.unref();
    const tick = async () => {
      await this.poll();
      if (this.running) { this.timer = setTimeout(() => void tick(), this.config.pollIntervalSeconds * 1000); this.timer.unref(); }
    };
    void tick();
  }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.collect().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async collect(): Promise<void> {
    const cycleStarted = Date.now();
    for (const endpoint of Object.keys(ENDPOINTS) as Endpoint[]) {
      if (this.stopped) return;
      if (endpoint === 'site' && this.readings.site?.at && Date.now() - this.readings.site.at < 300000) continue;
      try {
        const value = await this.source.read(endpoint);
        validate(endpoint, value);
        if (this.stopped) return;
        this.readings = { ...this.readings, [endpoint]: { value, at: Date.now() } };
      } catch (error) {
        if (this.stopped) return;
        this.readings = { ...this.readings, [endpoint]: { ...this.readings[endpoint], error: error instanceof Error ? error.message : 'Telemetry request failed' } };
        // An unreachable controller needs one probe per cycle, not seven timeouts.
        if (endpoint === 'status') break;
      }
    }
    this.revision++;
    const view = this.view();
    const power = (name: string) => {
      const m = view.meters.find(m => m.name === name && m.fresh);
      if (!m || m.at === null || (this.readings.meters?.at ?? 0) < cycleStarted || m.at <= (this.meterTimes.get(name) ?? 0)) return null;
      this.meterTimes.set(name, m.at); return m.power;
    };
    this.history = [...this.history, { at: view.now, battery: power('battery'), solar: power('solar'), soe: view.fresh.soe && (this.readings.soe?.at ?? 0) >= cycleStarted ? view.soe : null }].filter(p => p.at > view.now - 3600000).slice(-360);
    this.emit('update', this.view());
  }
  stop(): void {
    this.stopped = true; this.running = false;
    clearTimeout(this.timer); clearInterval(this.pulse); this.source.close();
  }
}
