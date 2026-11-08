import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import path from 'node:path';
import { number, record, string, type View, type Meter, type Point } from './telemetry';

const C = { bg: '#09131a', panel: '#101f29', border: '#243742', text: '#edf4f4', muted: '#91a8b4', green: '#71e6b3', blue: '#81c8ed', amber: '#ffc276', red: '#ff8e93' };
export const escapeXml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const fmt = (n: unknown, digits = 1) => number(n) === null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const scaled = (n: unknown, divisor = 1000, digits = 1) => number(n) === null ? '—' : fmt(Number(n) / divisor, digits);
const shorten = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;
const txt = (x: number, y: number, s: string, size = 22, color = C.text, weight = 400, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(s)}</text>`;
const box = (x: number, y: number, w: number, h: number, fill = C.panel, radius = 22) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${C.border}"/>`;
const rule = (x: number, y: number, w: number) => `<path d="M${x} ${y}h${w}" stroke="${C.border}"/>`;
const pill = (x: number, y: number, w: number, label: string, color = C.green) => `<rect x="${x}" y="${y}" width="${w}" height="32" rx="16" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-opacity=".3"/>${txt(x + w / 2, y + 22, label, 15, color, 700, 'middle')}`;
const age = (at: number | undefined, now: number) => at === undefined ? 'never received' : `${Math.max(0, Math.floor((now - at) / 1000))}s ago`;
const sectionStatus = (view: View, key: keyof View['fresh']) => view.readings[key]?.at === undefined ? 'UNAVAILABLE' : !view.fresh[key] ? 'STALE' : view.readings[key]?.error ? 'RETRYING' : '';
const alertDetail = (detail: string): string => {
  try {
    const data = record(JSON.parse(detail));
    const reason = [string(data.reason), string(data.battery_percentage_error)].filter(Boolean).join(' · ');
    if (reason) return reason;
    if (data.battery_idx !== undefined) return `Battery block ${Number(data.battery_idx) + 1}`;
  } catch { /* Plain text diagnostic detail. */ }
  return detail;
};

function historyChart(points: Point[], x: number, y: number, w: number, h: number): string {
  if (points.length < 2) return txt(x + w / 2, y + h / 2, 'Collecting local history…', 21, C.muted, 400, 'middle');
  const start = points[0].at, end = points.at(-1)!.at;
  const values = points.flatMap(p => [p.battery, p.solar]).filter((n): n is number => n !== null);
  if (!values.length || end <= start) return txt(x, y + h / 2, 'No fresh power readings', 20, C.muted);
  const min = Math.min(0, ...values), max = Math.max(1000, ...values);
  const low = min < 0 ? min * 1.15 : 0, high = max * 1.15;
  const py = (v: number) => y + h - (v - low) / (high - low) * h;
  let result = `<path d="M${x} ${py(0)}h${w}" stroke="${C.border}" stroke-dasharray="4 5"/>`;
  for (const [key, color] of [['battery', C.green], ['solar', C.amber]] as const) {
    let d = '', gap = true;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null) { gap = true; return; }
      if (i > 0 && p.at - points[i - 1].at > 90000) gap = true;
      d += `${gap ? 'M' : 'L'}${(x + (p.at - start) / (end - start) * w).toFixed(1)} ${py(v).toFixed(1)} `; gap = false;
    });
    result += `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return result + txt(x, y + h + 25, `${Math.max(1, Math.round((end - start) / 60000))} min of locally collected data`, 15, C.muted) + txt(x + w, y + h + 25, 'NOW', 13, C.muted, 700, 'end');
}

/** Original vector illustration; numbered pod slots are schematic, not individual measurements. */
function cabinet(view: View): string {
  const b = view.blocks[0];
  const fresh = view.fresh.status;
  const color = !fresh ? C.muted : view.health.equipmentFault ? C.amber : C.green;
  const slots = Math.min(16, Math.max(0, Math.floor(b?.pods ?? 16)));
  const fillHeight = Math.max(0, Math.min(100, view.soe ?? 0)) * 2.5;
  let svg = `<ellipse cx="249" cy="726" rx="151" ry="18" fill="#000" opacity=".25"/>
    <path d="M127 374L160 353H358L326 374Z" fill="#dce7e9"/>
    <path d="M326 374L358 353V696L326 722Z" fill="url(#side)"/>
    <rect x="127" y="374" width="199" height="348" rx="10" fill="url(#cabinet)"/>
    ${txt(227, 401, 'POWERPACK', 17, '#354951', 700, 'middle')}
    <rect x="142" y="418" width="170" height="238" rx="9" fill="#142630" stroke="#58717c"/>
    <rect x="150" y="426" width="154" height="222" rx="5" fill="#0b1921"/>
    <rect x="112" y="435" width="4" height="250" rx="2" fill="${C.border}"/>
    <rect x="112" y="${685 - fillHeight}" width="4" height="${fillHeight}" rx="2" fill="${view.fresh.soe ? C.green : C.muted}"/>
    <circle cx="298" cy="395" r="3.5" fill="${color}"/>`;
  for (let i = 0; i < slots; i++) {
    const x = 158 + i % 4 * 36, y = 436 + Math.floor(i / 4) * 51;
    svg += `<rect x="${x}" y="${y}" width="30" height="42" rx="3" fill="#28424b" stroke="#48646e"/>
      <path d="M${x + 5} ${y + 8}h20m-20 5h20m-20 5h20" stroke="#68858d" stroke-opacity=".6"/>
      ${txt(x + 15, y + 34, String(i + 1).padStart(2, '0'), 10, '#bed1d5', 700, 'middle')}`;
  }
  svg += `<path d="M148 673h157m-157 6h157m-157 6h157" stroke="#78949d" stroke-width="2"/>
    <rect x="147" y="701" width="159" height="6" rx="3" fill="#839da5"/>
    <path d="M326 612h38v62h27" fill="none" stroke="${C.blue}" stroke-width="2"/>
    ${box(383, 639, 106, 64, '#182d37', 10)}
    ${box(501, 639, 106, 64, '#182d37', 10)}
    ${txt(436, 665, 'AC', 20, C.blue, 700, 'middle')}${txt(554, 665, 'AC', 20, C.blue, 700, 'middle')}
    ${txt(436, 688, 'INVERTER', 11, C.muted, 700, 'middle')}${txt(554, 688, 'INVERTER', 11, C.muted, 700, 'middle')}
    ${txt(383, 732, 'Inverters shown schematically', 14, C.muted)}`;
  return svg;
}

export function dashboardSvg(view: View, name = 'Powerpack'): string {
  const s = view.status, b = view.blocks[0], battery = view.meters.find(m => m.name === 'battery'), solar = view.meters.find(m => m.name === 'solar');
  const load = view.meters.find(m => m.name === 'load' || m.name === 'site');
  const state = view.health.unreachable ? view.readings.status?.at ? 'TELEMETRY STALE' : 'CONNECTING' : view.health.islanded === true ? 'ISLANDED' : view.health.islanded === false ? 'GRID CONNECTED' : 'STATE UNKNOWN';
  const accent = view.health.unreachable || view.health.islanded === null ? C.amber : C.green;
  const card = (x: number, label: string, value: string, unit: string, detail: string, color: string, unavailable = false) => box(x, 126, 441, 147) +
    txt(x + 25, 159, label, 17, C.muted, 700) + txt(x + 25, 222, value, 51, unavailable ? C.muted : C.text, 700) + txt(x + 415, 216, unit, 22, color, 700, 'end') +
    txt(x + 25, 251, detail, 16, unavailable ? C.amber : C.muted);
  const flowPower = (meter: Meter | undefined) => meter?.fresh ? `${scaled(meter.power, 1000, 2)} kW` : '—';
  const batteryDirection = view.health.charging === null ? 'No fresh meter reading' : view.health.discharging ? 'Discharging · positive battery power' : view.health.charging ? 'Charging · negative battery power' : 'Near idle';
  const metrics = [
    ['Voltage', (m: Meter | undefined) => `${fmt(m?.voltage)} V`],
    ['Current', (m: Meter | undefined) => `${fmt(m?.current, 2)} A`],
    ['Frequency', (m: Meter | undefined) => `${fmt(m?.frequency, 2)} Hz`],
    ['Reactive', (m: Meter | undefined) => `${scaled(m?.reactive, 1000, 2)} kvar`],
    ['Apparent', (m: Meter | undefined) => `${scaled(m?.apparent, 1000, 2)} kVA`],
    ['Imported', (m: Meter | undefined) => `${scaled(m?.imported, 1e6, 2)} MWh`],
    ['Exported', (m: Meter | undefined) => `${scaled(m?.exported, 1e6, 2)} MWh`],
  ] as const;
  const limits = [
    ['Charge available', `${scaled(s.max_charge_power)} kW`, C.blue],
    ['Discharge available', `${scaled(s.max_discharge_power)} kW`, C.green],
    ['Apparent limit', `${scaled(s.max_apparent_power)} kVA`, C.text],
    ['Remaining at max power', `${scaled(s.max_power_energy_remaining)} kWh`, C.text],
    ['Energy to charge', `${scaled(s.max_power_energy_to_be_charged)} kWh`, C.text],
  ];
  const alerts = view.alerts.slice(0, 3);
  const firmware = string(record(view.site.firmware).version) || '—';
  const endpointIssues = (Object.keys(view.fresh) as (keyof View['fresh'])[]).filter(k => !view.fresh[k] || view.readings[k]?.error);
  const footer = `${view.health.unreachable ? 'STALE / UNAVAILABLE' : 'LOCAL TELEMETRY'}  ·  Status ${age(view.readings.status?.at, view.now)}${endpointIssues.length ? '  ·  ' + endpointIssues.length + ' source(s) delayed / unavailable' : '  ·  All 7 sources current'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#102731"/><stop offset=".55" stop-color="#09161f"/><stop offset="1" stop-color="#09131a"/></linearGradient>
    <linearGradient id="cabinet"><stop stop-color="#d7e3e5"/><stop offset=".45" stop-color="#f1f5f4"/><stop offset="1" stop-color="#bdcfd2"/></linearGradient>
    <linearGradient id="side"><stop stop-color="#708b96"/><stop offset="1" stop-color="#a1b7bf"/></linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <g font-family="Manrope, sans-serif">
  <rect x="48" y="40" width="50" height="50" rx="14" fill="${C.green}" fill-opacity=".1" stroke="${C.green}" stroke-opacity=".35"/>
  <path d="M76 48L62 67H73L68 82L84 61H74Z" fill="${C.green}"/>
  ${txt(116, 67, shorten(name, 34), 35, C.text, 700)}${txt(116, 94, 'TESLA POWERPACK  /  ENERGY OVERVIEW', 14, C.muted, 700)}
  ${pill(1422, 43, 234, state, accent)}
  ${txt(1872, 65, new Date(view.now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }), 26, C.text, 700, 'end')}
  ${txt(1872, 91, new Date(view.now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), 14, C.muted, 400, 'end')}
  ${card(48, 'STATE OF ENERGY', fmt(view.soe), '%', sectionStatus(view, 'soe') || 'Reported battery state of energy', C.green, !view.fresh.soe)}
  ${card(509, 'STORED ENERGY', scaled(s.nominal_energy_remaining), 'kWh', sectionStatus(view, 'status') || `Nominal full pack  ${scaled(s.nominal_full_pack_energy)} kWh`, C.green, !view.fresh.status)}
  ${card(970, 'BATTERY POWER', scaled(battery?.power, 1000, 2), 'kW', battery?.fresh ? batteryDirection : 'STALE / UNAVAILABLE', C.blue, !battery?.fresh)}
  ${card(1431, 'SOLAR POWER', scaled(solar?.power, 1000, 2), 'kW', solar?.fresh ? 'Measured generation' : 'STALE / UNAVAILABLE', C.amber, !solar?.fresh)}

  ${box(48, 293, 720, 506)}${txt(76, 331, 'Inside the Powerpack', 25, C.text, 700)}
  ${txt(740, 330, b ? `BLOCK 1 / ${view.blocks.length}` : 'NO BLOCK DATA', 14, C.muted, 700, 'end')}
  ${cabinet(view)}
  ${txt(383, 388, 'BATTERY PODS', 15, C.muted, 700)}
  ${txt(383, 435, fmt(b?.pods, 0), 43, view.fresh.status ? C.text : C.muted, 700)}${txt(458, 435, 'reported', 19, C.muted)}
  ${txt(383, 468, `${fmt(b?.podFaults, 0)} faulted`, 23, (b?.podFaults ?? 0) > 0 ? C.amber : C.text, 700)}
  ${rule(383, 489, 330)}
  ${txt(383, 520, 'INVERTERS', 15, C.muted, 700)}
  ${txt(383, 562, `${fmt(b?.inverters, 0)} connected`, 29, C.text, 700)}
  ${txt(383, 592, `${fmt(b?.inverterFaults, 0)} faulted  ·  ${shorten(b?.state || 'Unknown state', 18)}`, 20, (b?.inverterFaults ?? 0) > 0 ? C.amber : C.muted)}
  ${txt(76, 765, sectionStatus(view, 'status') || shorten(b?.states.join('  ·  ') || 'Waiting for block status', 68), 17, view.fresh.status ? C.green : C.amber, 700)}
  ${txt(76, 786, 'Schematic layout. Individual pod temperatures / voltages unavailable.', 13, C.muted)}

  ${box(788, 293, 470, 506)}${txt(816, 331, 'Site & power limits', 25, C.text, 700)}
  ${pill(816, 353, 204, view.health.islanded === true ? 'ISLAND OPERATION' : view.health.islanded === false ? 'ON GRID' : 'STATE UNKNOWN', accent)}
  ${txt(1230, 375, view.fresh.gridFaults ? `${view.gridFaults?.length ?? 0} grid faults` : 'Faults unknown', 16, view.fresh.gridFaults && !view.gridFaults?.length ? C.muted : C.amber, 400, 'end')}
  ${txt(816, 414, 'SOLAR', 13, C.amber, 700)}${txt(1022, 414, 'BATTERY', 13, C.green, 700)}${txt(1230, 414, 'SITE', 13, C.blue, 700, 'end')}
  <path d="M829 433h169m39 0h165" stroke="${C.border}" stroke-width="3"/>
  <circle cx="835" cy="433" r="7" fill="${solar?.fresh ? C.amber : C.muted}"/>
  <rect x="1001" y="423" width="25" height="20" rx="3" fill="${C.green}"/>
  <path d="M1205 425l11 8-11 8" fill="none" stroke="${C.blue}" stroke-width="2"/>
  ${txt(816, 467, flowPower(solar), 19, C.amber, 700)}${txt(1022, 467, flowPower(battery), 19, C.green, 700)}${txt(1230, 467, load ? flowPower(load) : 'No load meter', load ? 19 : 13, C.muted, 400, 'end')}
  ${rule(816, 487, 414)}
  ${limits.map(([label, value, color], i) => txt(816, 524 + i * 41, label, 18, C.muted) + txt(1230, 524 + i * 41, value, 21, view.fresh.status ? color : C.muted, 700, 'end')).join('')}
  ${rule(816, 713, 414)}
  ${txt(816, 743, `Command source: ${shorten(string(s.command_source) || '—', 23)}`, 16, C.muted)}
  ${txt(816, 775, sectionStatus(view, 'status') || `Targets  ${scaled(s.battery_target_power)} kW / ${scaled(s.battery_target_reactive_power)} kvar`, 16, view.fresh.status ? C.muted : C.amber)}

  ${box(1278, 293, 594, 506)}${txt(1306, 331, 'Electrical telemetry', 25, C.text, 700)}
  ${txt(1605, 379, 'BATTERY', 15, battery?.fresh ? C.green : C.amber, 700, 'end')}${txt(1844, 379, 'SOLAR', 15, solar?.fresh ? C.amber : C.muted, 700, 'end')}
  ${rule(1306, 397, 538)}
  ${metrics.map(([label, value], i) => txt(1306, 433 + i * 42, label, 20, C.muted) + txt(1605, 433 + i * 42, value(battery), 22, battery?.fresh ? C.text : C.muted, 700, 'end') + txt(1844, 433 + i * 42, value(solar), 22, solar?.fresh ? C.text : C.muted, 700, 'end')).join('')}
  ${rule(1306, 715, 538)}
  ${txt(1306, 746, `Battery ${battery?.fresh ? 'current' : 'stale / unavailable'}  ·  Solar ${solar?.fresh ? 'current' : 'stale / unavailable'}`, 16, battery?.fresh && solar?.fresh ? C.muted : C.amber)}
  ${txt(1306, 776, `Meters: ${shorten(view.meters.map(m => m.name).join(', ') || 'none received', 53)}`, 15, C.muted)}

  ${box(48, 819, 850, 197)}${txt(76, 854, 'Power trend', 23, C.text, 700)}
  ${txt(871, 854, 'BATTERY  /  SOLAR  ·  kW', 14, C.muted, 700, 'end')}
  ${historyChart(view.history, 76, 876, 795, 91)}
  ${box(918, 819, 954, 197)}${txt(946, 854, 'Controller alerts', 23, C.text, 700)}
  ${txt(1844, 854, sectionStatus(view, 'alerts') || `${view.alerts.length} REPORTED  ·  NO EVENT TIMESTAMPS`, 13, view.fresh.alerts ? C.muted : C.amber, 700, 'end')}
  ${alerts.length ? alerts.map((a, i) => `<circle cx="951" cy="${886 + i * 34}" r="4" fill="${C.amber}"/>` + txt(966, 892 + i * 34, shorten(a.name.replace(/([a-z])([A-Z])/g, '$1 $2'), 35), 18, C.text, 700) + txt(1844, 892 + i * 34, shorten(alertDetail(a.detail), 46), 14, C.muted, 400, 'end')).join('') : txt(946, 919, view.fresh.alerts ? 'No controller alerts reported' : 'Alert data unavailable', 21, C.muted)}
  ${txt(946, 998, view.alerts.length > 3 ? `+${view.alerts.length - 3} more alerts in MQTT / probe output` : 'Alert records are shown separately from current block fault counts.', 14, C.muted)}
  ${txt(48, 1053, footer, 17, view.health.unreachable || endpointIssues.length ? C.amber : C.muted)}
  ${txt(1872, 1053, `FW ${shorten(firmware, 22)}  ·  READ ONLY`, 15, C.muted, 700, 'end')}
  </g></svg>`;
}

export class DashboardRenderer {
  private cache = new Map<string, Promise<Buffer>>();
  constructor(private readonly getView: () => View, private readonly name = 'Powerpack') {}
  async render(width = 1920, height = 1080, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
    const w = Math.min(1920, Math.max(160, Math.round(width))), h = Math.min(1080, Math.max(90, Math.round(height)));
    const view = this.getView(), key = `${view.revision}:${Math.floor(view.now / 5000)}:${w}:${h}:${format}`;
    let result = this.cache.get(key);
    if (!result) {
      if (this.cache.size > 8) this.cache.clear();
      result = (async () => {
        const png = new Resvg(dashboardSvg(view, this.name), { font: {
          fontFiles: ['Manrope-Regular.ttf', 'Manrope-Bold.ttf'].map(file => path.join(__dirname, '../assets', file)), loadSystemFonts: false, defaultFontFamily: 'Manrope',
        } }).render().asPng();
        const resized = sharp(png).resize(w, h, { fit: 'contain', background: C.bg });
        return format === 'png' ? resized.png().toBuffer() : resized.jpeg({ quality: 90 }).toBuffer();
      })();
      this.cache.set(key, result); result.catch(() => this.cache.delete(key));
    }
    return result;
  }
}
