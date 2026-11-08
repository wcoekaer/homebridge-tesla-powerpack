import fs from 'node:fs/promises';
import path from 'node:path';
import { PowerpackClient } from './client';
import { settings } from './config';
import { makeView, TelemetryMonitor, type View } from './telemetry';
import { DashboardRenderer, dashboardSvg } from './dashboard';
import { demoReadings, demoHistory } from './demo';
import { exportState } from './mqtt';

async function main(): Promise<void> {
  const args = process.argv.slice(2), command = args.shift();
  const option = (flag: string, fallback?: string) => {
    const at = args.indexOf(flag);
    if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--'))) throw new Error(`Missing value for ${flag}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  if (!['preview', 'probe'].includes(command || '')) throw new Error('Usage: node dist/cli.js preview|probe --demo OR --host IP --token-file PATH --ca-file PATH [--port 10443] [--servername localhost] [--output artifacts/dashboard.png] [--json]');
  const demo = args.includes('--demo');
  const config = settings({ host: option('--host', '192.168.0.49'), port: Number(option('--port', '10443')), servername: option('--servername', 'localhost'),
    tokenFile: option('--token-file', demo ? '/unused/demo-token' : ''), caFile: option('--ca-file', demo ? '/unused/demo-ca' : '') });
  let view: View;
  if (demo) { const now = Date.now(); view = makeView(demoReadings(now), config, now, 1, demoHistory(now)); }
  else {
    const monitor = new TelemetryMonitor(new PowerpackClient(config), config);
    try { await monitor.poll(); view = monitor.view(); }
    finally { monitor.stop(); }
    if (view.health.unreachable) throw new Error(view.readings.status?.error || 'No valid controller status received');
  }
  const state = exportState(view);
  console.log(JSON.stringify(args.includes('--json') ? { ...state, raw: view.readings } : {
    available: state.available, stateOfEnergyPercent: state.stateOfEnergyPercent, energyRemainingWh: state.energyRemainingWh,
    gridState: state.gridState, health: view.health, meters: state.meters,
    blocks: view.blocks.map(b => ({ pods: b.pods, podFaults: b.podFaults, inverters: b.inverters, inverterFaults: b.inverterFaults, states: b.states })),
    alertNames: view.alerts.map(a => a.name), endpoints: state.endpoints,
  }, null, 2));
  if (command === 'preview') {
    const output = path.resolve(option('--output', 'artifacts/dashboard.png')!);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const name = demo ? 'Powerpack · Demo' : 'Powerpack';
    await fs.writeFile(output, await new DashboardRenderer(() => view, name).render(1920, 1080, 'png'));
    await fs.writeFile(output.replace(/\.[^.]+$/, '') + '.svg', dashboardSvg(view, name));
    console.log(`Dashboard: ${output}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
