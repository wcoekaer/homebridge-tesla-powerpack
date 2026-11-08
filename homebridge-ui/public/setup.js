'use strict';
(async () => {
  const hb = window.homebridge, status = document.getElementById('pp-status');
  const buttons = ['pp-upload', 'pp-test'].map(id => document.getElementById(id));
  const busy = value => buttons.forEach(button => { button.disabled = value; });
  const show = (message, error = false) => { status.textContent = message; status.className = error ? 'text-danger' : 'text-success'; };
  try {
    let blocks = await hb.getPluginConfig();
    if (!blocks.length) await hb.updatePluginConfig([{ platform: 'TeslaPowerpack', name: 'Powerpack', host: '192.168.0.49', port: 10443, servername: 'localhost', mqtt: { enabled: false } }]);
    else if (blocks[0].tokenFile && blocks[0].caFile) show('Credentials configured. Upload a new pair to replace them.');
    hb.showSchemaForm();
    document.getElementById('pp-upload').addEventListener('click', async () => {
      busy(true);
      try {
        const pem = document.getElementById('pp-pem').files[0], token = document.getElementById('pp-token').files[0];
        if (!pem || !token) throw new Error('Choose both the PEM certificate and token file.');
        if (pem.size > 65536 || token.size > 16384) throw new Error('Files exceed the 64 KiB certificate / 16 KiB token limits.');
        const stored = await hb.request('/credentials', { pem: await pem.text(), token: await token.text() });
        blocks = await hb.getPluginConfig();
        blocks[0] = { ...blocks[0], tokenFile: stored.tokenFile, caFile: stored.caFile };
        await hb.updatePluginConfig(blocks);
        document.getElementById('pp-pem').value = ''; document.getElementById('pp-token').value = '';
        show('Credentials stored. Click Save to keep this configuration, then restart the child bridge.');
      } catch (error) { show(error.message || 'Could not store credentials.', true); }
      finally { busy(false); }
    });
    document.getElementById('pp-test').addEventListener('click', async () => {
      busy(true); show('Reading controller status…');
      try {
        const config = (await hb.getPluginConfig())[0];
        const result = await hb.request('/probe', config);
        show(`GET succeeded: ${result.blocks} battery block(s), state ${result.state}.`);
      } catch (error) { show(error.message || 'Telemetry GET failed.', true); }
      finally { busy(false); }
    });
  } catch { show('Unable to load setup. Close and reopen the plugin settings.', true); }
})();
