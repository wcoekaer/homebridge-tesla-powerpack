import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

export const PLUGIN_NAME = '@wcoekaer/homebridge-tesla-powerpack';
export const ACCESSORY_NAMESPACE = 'homebridge-tesla-powerpack';
export const PLATFORM_NAME = 'TeslaPowerpack';

export interface Settings {
  name: string; host: string; port: number; servername: string; tokenFile: string; caFile: string;
  pollIntervalSeconds: number; timeoutSeconds: number; staleAfterSeconds: number;
  lowBatteryPercent: number; lowBatteryRecoveryPercent: number;
  batteryThresholds: number[]; powerActivityThresholdWatts: number;
  sensors: { islanded: boolean; lowBattery: boolean; equipmentFault: boolean; unreachable: boolean; charging: boolean; discharging: boolean };
  camera: { enabled: boolean; name: string; ffmpegPath: string; maxStreams: number };
  mqtt: { enabled: boolean; url: string; username: string; password: string; topicPrefix: string; clientId: string; retain: boolean; raw: boolean; caFile: string };
}

export function settings(raw: Record<string, any> = {}): Settings {
  const n = (key: string, fallback: number, min: number, max: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
    return value;
  };
  const name = String(raw.name || 'Powerpack').trim().slice(0, 50);
  const host = String(raw.host || '192.168.0.49').trim();
  const servername = String(raw.servername || 'localhost').trim();
  const hostname = (s: string) => !!isIP(s) || /^(?=.{1,253}$)[a-zA-Z0-9]+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s);
  if (!hostname(host) || !hostname(servername)) throw new Error('host and servername must be IP addresses or hostnames, without a URL or port');
  const tokenFile = String(raw.tokenFile || ''), caFile = String(raw.caFile || '');
  if (!isAbsolute(tokenFile) || !isAbsolute(caFile)) throw new Error('tokenFile and caFile must be absolute paths readable by Homebridge');
  const port = n('port', 10443, 1, 65535);
  if (!Number.isInteger(port)) throw new Error('port must be an integer');
  const poll = n('pollIntervalSeconds', 15, 10, 300), stale = n('staleAfterSeconds', 90, 30, 1800);
  if (stale < poll * 2) throw new Error('staleAfterSeconds must be at least twice pollIntervalSeconds');
  const low = n('lowBatteryPercent', 15, 0, 99), recovery = n('lowBatteryRecoveryPercent', 20, 1, 100);
  if (recovery <= low) throw new Error('lowBatteryRecoveryPercent must exceed lowBatteryPercent');
  const thresholds: unknown = raw.batteryThresholds ?? [20, 50, 80];
  if (!Array.isArray(thresholds) || thresholds.length > 10 || thresholds.some(v => !Number.isInteger(v) || v < 1 || v > 99)) throw new Error('batteryThresholds must contain up to 10 integer percentages between 1 and 99');
  const camera = raw.camera ?? {}, streams = camera.maxStreams ?? 2;
  if (!Number.isInteger(streams) || streams < 1 || streams > 4) throw new Error('camera.maxStreams must be 1–4');
  const mqtt = raw.mqtt ?? {};
  const url = String(mqtt.url || 'mqtt://localhost:1883');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('mqtt.url must be an mqtt:// or mqtts:// broker URL'); }
  if (!['mqtt:', 'mqtts:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) throw new Error('mqtt.url must use mqtt:// or mqtts://; enter credentials in the separate fields');
  const topicPrefix = String(mqtt.topicPrefix || 'tesla/powerpack').replace(/\/+$/, '');
  if (!/^[a-zA-Z0-9_/-]{1,150}$/.test(topicPrefix)) throw new Error('mqtt.topicPrefix must contain only letters, numbers, underscores, hyphens, and slashes');
  if (mqtt.caFile && !isAbsolute(String(mqtt.caFile))) throw new Error('mqtt.caFile must be an absolute path');
  return {
    name, host, port, servername, tokenFile, caFile, pollIntervalSeconds: poll,
    timeoutSeconds: n('timeoutSeconds', 5, 1, 20), staleAfterSeconds: stale,
    lowBatteryPercent: low, lowBatteryRecoveryPercent: recovery,
    batteryThresholds: [...new Set(thresholds as number[])].sort((a, b) => a - b), powerActivityThresholdWatts: n('powerActivityThresholdWatts', 100, 1, 10000),
    sensors: { islanded: raw.sensors?.islanded !== false, lowBattery: raw.sensors?.lowBattery !== false, equipmentFault: raw.sensors?.equipmentFault !== false, unreachable: raw.sensors?.unreachable !== false, charging: raw.sensors?.charging !== false, discharging: raw.sensors?.discharging !== false },
    camera: { enabled: camera.enabled !== false, name: String(camera.name || `${name} Dashboard`).slice(0, 64), ffmpegPath: String(camera.ffmpegPath || ''), maxStreams: streams },
    mqtt: { enabled: mqtt.enabled === true, url, username: String(mqtt.username || ''), password: String(mqtt.password || ''), topicPrefix,
      clientId: String(mqtt.clientId || '').slice(0, 100), retain: mqtt.retain !== false, raw: mqtt.raw !== false, caFile: String(mqtt.caFile || '') },
  };
}
