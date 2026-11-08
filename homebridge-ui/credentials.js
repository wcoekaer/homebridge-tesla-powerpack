'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');

async function storeCredentials(storagePath, payload) {
  if (!storagePath || !path.isAbsolute(storagePath)) throw new Error('Homebridge storage path is unavailable');
  if (!payload || typeof payload.token !== 'string' || typeof payload.pem !== 'string' || payload.token.length > 16384 || payload.pem.length > 65536) throw new Error('Select a token file and a PEM CA certificate (maximum 16 KiB / 64 KiB)');
  const token = payload.token.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9_.~+\/-]+=*$/.test(token)) throw new Error('The token file must contain one bearer token');
  if (/PRIVATE KEY/.test(payload.pem)) throw new Error('Upload the CA certificate only, without a private key');
  let certificate;
  try { certificate = new X509Certificate(payload.pem); } catch { throw new Error('The PEM file is not a valid X.509 certificate'); }
  if (!certificate.ca) throw new Error('The PEM must be the site controller CA certificate');
  if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error('The CA certificate is expired or not yet valid');
  const base = path.join(storagePath, 'tesla-powerpack');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  // A new directory makes each upload atomic from the config's perspective.
  // The browser cannot choose a destination or overwrite existing files.
  const dir = await fs.mkdtemp(path.join(base, 'credentials-'));
  try {
    await fs.chmod(dir, 0o700);
    const tokenFile = path.join(dir, 'token'), caFile = path.join(dir, 'ca.pem');
    await fs.writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(caFile, certificate.toString(), { flag: 'wx', mode: 0o600 });
    return { tokenFile, caFile, certificateExpires: certificate.validTo };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
module.exports = { storeCredentials };
