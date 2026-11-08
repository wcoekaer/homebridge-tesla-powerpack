import type { Readings, Point } from './telemetry';

/** Synthetic fixtures only. Never copy a site's credentials or identifiers into this file. */
export function demoReadings(now = Date.now()): Readings {
  const meter = (power: number, imported: number, exported: number) => ({ instant_power: power, instant_reactive_power: -42, instant_apparent_power: Math.abs(power) + 5,
    instant_average_voltage: 480.1, instant_total_current: Math.abs(power) / 830, frequency: 60.01, energy_imported: imported, energy_exported: exported,
    last_communication_time: new Date(now).toISOString(), timeout: 60000000000 });
  return {
    status: { at: now, value: { nominal_full_pack_energy: 220000, nominal_energy_remaining: 182380, max_power_energy_remaining: 181200,
      max_power_energy_to_be_charged: 37620, max_charge_power: 67500, max_discharge_power: 65800, max_apparent_power: 143000,
      instantaneous_max_charge_power: 67500, instantaneous_max_discharge_power: 65800, inverter_nominal_usable_power: 143000,
      command_source: 'NothingActive', battery_target_power: 0, battery_target_reactive_power: 0, available_blocks: 1, blocks_controlled: 1,
      system_island_state: 'SystemIslandedActive', auxiliary_load: 0, primary: true, grid_faults: [],
      battery_blocks: [{ id: 'demo-block-01', package_serial_number: 'DEMO-POWERPACK-01', package_part_number: 'DEMO-1134768', fw_version: 'demo.1',
        states: ['VF Mode', 'OK', 'Reachable'], opState: 'Active', num_pods_reported: 16, num_pods_faulted: 0, num_tinv_connected: 2, num_tinv_faulted: 0,
        faulted_reason: '', power_limited_reason: 'PwrLimReason_None', disabled_reasons: null, self_test_status: { state: 'NOT_STARTED' } }] } },
    soe: { at: now, value: { percentage: 82.9 } },
    meters: { at: now, value: { battery: meter(12800, 118900000, 60500000), solar: meter(8400, 0, 188600000) } },
    grid: { at: now, value: { grid_status: 'SystemIslandedActive', grid_services_active: false } },
    gridFaults: { at: now, value: [] },
    alerts: { at: now, value: [{ name: 'SmartInverterActive', data: 'Demonstration alert', sub_device: 0 }] },
    site: { at: now, value: { site_name: 'Demonstration site', firmware: { version: '26.10.4-demo' }, build_platform: 'ISC', product: 'sm', product_variant: 'ind', product_platform: 'pc' } },
  };
}
export function demoHistory(now = Date.now()): Point[] {
  return Array.from({ length: 121 }, (_, i) => ({ at: now - (120 - i) * 15000,
    battery: 9500 + Math.sin(i / 13) * 4500 + Math.sin(i / 4) * 700,
    solar: 6000 + Math.sin(i / 35) * 2500, soe: 89 - i * 0.05 }));
}
