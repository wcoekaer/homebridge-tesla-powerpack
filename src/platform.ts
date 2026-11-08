import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge' with { 'resolution-mode': 'import' };
import { settings, PLUGIN_NAME, PLATFORM_NAME, ACCESSORY_NAMESPACE, type Settings } from './config';
import { PowerpackClient } from './client';
import { TelemetryMonitor, type View } from './telemetry';
import { DashboardRenderer } from './dashboard';
import { DashboardCamera } from './camera';
import { TelemetryPublisher } from './mqtt';

type SensorKind = keyof View['health'];
export class PowerpackPlatform implements DynamicPlatformPlugin {
  private readonly config: Settings;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly sensors = new Map<SensorKind, Service>();
  private readonly thresholdSensors = new Map<string, Service>();
  private batteryService?: Service;
  private monitor?: TelemetryMonitor;
  private camera?: DashboardCamera;
  private publisher?: TelemetryPublisher;
  private lastState?: string;
  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    this.config = settings(config);
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => { this.monitor?.stop(); this.camera?.shutdown(); void this.publisher?.stop(); });
  }
  configureAccessory(accessory: PlatformAccessory): void { this.accessories.set(accessory.UUID, accessory); }
  private launch(): void {
    let source: PowerpackClient;
    try { source = new PowerpackClient(this.config); } catch (error) { this.log.error('%s', error instanceof Error ? error.message : 'Cannot load Powerpack credentials'); return; }
    this.monitor = new TelemetryMonitor(source, this.config);
    const keep = new Set<string>();
    const accessory = (kind: string, name: string, category?: number): PlatformAccessory => {
      const uuid = this.api.hap.uuid.generate(`${ACCESSORY_NAMESPACE}:${this.config.host}:${this.config.port}:${kind}`);
      keep.add(uuid);
      let a = this.accessories.get(uuid);
      if (!a) { a = new this.api.platformAccessory(name, uuid, category); this.accessories.set(uuid, a); }
      a.displayName = name;
      a.getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Powerpack Monitor')
        .setCharacteristic(this.api.hap.Characteristic.Model, kind === 'camera' ? 'Telemetry Dashboard' : 'Energy System Health')
        .setCharacteristic(this.api.hap.Characteristic.SerialNumber, uuid.slice(0, 18))
        .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, require('../package.json').version as string);
      return a;
    };
    const newlyCreated: PlatformAccessory[] = [];
    const existingIds = new Set(this.accessories.keys());
    const labels: Record<SensorKind, string> = { islanded: 'Islanded', lowBattery: 'Battery', equipmentFault: 'Equipment Fault', unreachable: 'Monitor Unreachable', charging: 'Charging', discharging: 'Discharging' };
    for (const kind of Object.keys(labels) as SensorKind[]) {
      if (!this.config.sensors[kind]) continue;
      const name = `${this.config.name} ${labels[kind]}`;
      const a = accessory(kind, name, this.api.hap.Categories.SENSOR);
      const service = a.getService(this.api.hap.Service.ContactSensor) || a.addService(this.api.hap.Service.ContactSensor, name);
      service.setCharacteristic(this.api.hap.Characteristic.Name, name);
      service.getCharacteristic(this.api.hap.Characteristic.ContactSensorState).onGet(() => {
        const view = this.monitor!.view();
        if (view.health[kind] === null) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return view.health[kind] ? 1 : 0;
      });
      this.sensors.set(kind, service);
      if (kind === 'lowBattery') {
        const C = this.api.hap.Characteristic;
        const Battery = this.api.hap.Service.Battery ?? (this.api.hap.Service as any).BatteryService;
        this.batteryService = a.getService(Battery) || a.addService(Battery, `${this.config.name} Battery`);
        this.batteryService.setCharacteristic(C.Name, `${this.config.name} Battery`);
        this.batteryService.getCharacteristic(C.BatteryLevel).onGet(() => {
          const view = this.monitor!.view();
          if (!view.fresh.soe || view.soe === null) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return Math.round(view.soe);
        });
        this.batteryService.getCharacteristic(C.StatusLowBattery).onGet(() => {
          const value = this.monitor!.view().health.lowBattery;
          if (value === null) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return value ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        });
        this.batteryService.getCharacteristic(C.ChargingState).onGet(() => {
          const value = this.monitor!.view().health.charging;
          if (value === null) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return value ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING;
        });
      }
      if (!existingIds.has(a.UUID)) newlyCreated.push(a);
    }
    for (const threshold of this.config.batteryThresholds) {
      const key = String(threshold), name = `${this.config.name} At or Below ${threshold} Percent`;
      const a = accessory(`threshold-${key}`, name, this.api.hap.Categories.SENSOR);
      const service = a.getService(this.api.hap.Service.ContactSensor) || a.addService(this.api.hap.Service.ContactSensor, name);
      service.setCharacteristic(this.api.hap.Characteristic.Name, name);
      service.getCharacteristic(this.api.hap.Characteristic.ContactSensorState).onGet(() => {
        const value = this.monitor!.view().thresholds[key];
        if (value == null) throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return value ? 1 : 0;
      });
      this.thresholdSensors.set(key, service);
      if (!existingIds.has(a.UUID)) newlyCreated.push(a);
    }
    if (this.config.camera.enabled) {
      const a = accessory('camera', this.config.camera.name, this.api.hap.Categories.CAMERA);
      const renderer = new DashboardRenderer(() => this.monitor!.view(), this.config.name);
      this.camera = new DashboardCamera(this.api.hap, renderer, this.config.camera, this.log);
      a.configureController(this.camera.controller);
      if (!existingIds.has(a.UUID)) newlyCreated.push(a);
    }
    if (newlyCreated.length) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newlyCreated);
    const removed = [...this.accessories.values()].filter(a => !keep.has(a.UUID));
    if (removed.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
    this.api.updatePlatformAccessories([...this.accessories.values()].filter(a => keep.has(a.UUID)));
    this.publisher = new TelemetryPublisher(this.config, this.log);
    try { this.publisher.start(); } catch { this.log.warn('MQTT could not start; check its settings. Controller monitoring continues.'); }
    this.monitor.on('update', (view: View) => { this.update(view); this.publisher?.update(view); });
    this.update(this.monitor.view());
    this.monitor.start();
    this.log.info('Monitoring %s:%s; %s health sensors%s. All controller requests are allowlisted telemetry GETs.', this.config.host, this.config.port, this.sensors.size, this.config.camera.enabled ? ' and dashboard camera' : '');
  }
  private update(view: View): void {
    const C = this.api.hap.Characteristic;
    for (const [kind, service] of this.sensors) {
      const faulty = view.health[kind] === null;
      service.updateCharacteristic(C.StatusFault, faulty ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
      service.updateCharacteristic(C.StatusActive, !faulty);
      // Preserve the previous alarm during a telemetry outage; fault does not mean recovery.
      if (!faulty) service.updateCharacteristic(C.ContactSensorState, view.health[kind] ? 1 : 0);
    }
    for (const [key, service] of this.thresholdSensors) {
      const value = view.thresholds[key];
      service.updateCharacteristic(C.StatusFault, value === null ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
      service.updateCharacteristic(C.StatusActive, value !== null);
      if (value !== null) service.updateCharacteristic(C.ContactSensorState, value ? 1 : 0);
    }
    if (this.batteryService) {
      const fault = () => new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      if (view.fresh.soe && view.soe !== null) this.batteryService.updateCharacteristic(C.BatteryLevel, Math.round(view.soe));
      else this.batteryService.updateCharacteristic(C.BatteryLevel, fault());
      if (view.health.lowBattery !== null) this.batteryService.updateCharacteristic(C.StatusLowBattery, view.health.lowBattery ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      else this.batteryService.updateCharacteristic(C.StatusLowBattery, fault());
      if (view.health.charging !== null) this.batteryService.updateCharacteristic(C.ChargingState, view.health.charging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
      else this.batteryService.updateCharacteristic(C.ChargingState, fault());
    }
    const state = JSON.stringify(view.health);
    if (state !== this.lastState) {
      this.lastState = state;
      if (view.health.unreachable) this.log.warn('Controller telemetry unavailable at %s:%s. Last error: %s', this.config.host, this.config.port, view.readings.status?.error || 'Waiting for the first reading');
      else this.log.info('Health: islanded=%s lowBattery=%s equipmentFault=%s', view.health.islanded, view.health.lowBattery, view.health.equipmentFault);
    }

  }
}
