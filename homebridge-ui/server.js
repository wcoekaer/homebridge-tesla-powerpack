'use strict';
const { storeCredentials } = require('./credentials');
const { settings } = require('../dist/config');
const { PowerpackClient } = require('../dist/client');

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/credentials', async payload => {
        try { return await storeCredentials(this.homebridgeStoragePath, payload); }
        catch (error) { throw new RequestError(error.code ? 'Unable to store credentials in Homebridge storage; check filesystem permissions' : error.message, { status: 400 }); }
      });
      this.onRequest('/probe', async payload => {
        let client;
        try {
          client = new PowerpackClient(settings(payload || {}));
          const status = await client.read('status');
          if (!status || typeof status !== 'object' || !Array.isArray(status.battery_blocks)) throw new Error('Controller returned an unexpected status response');
          return { ok: true, blocks: status.battery_blocks.length, state: status.system_island_state || 'Unknown' };
        } catch (error) { throw new RequestError(error.message || 'Telemetry GET failed', { status: 400 }); }
        finally { client?.close(); }
      });
      this.ready();
    }
  }
  new UiServer();
})().catch(() => { console.error('Unable to start Powerpack setup server'); process.exitCode = 1; });
