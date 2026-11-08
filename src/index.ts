import type { API } from 'homebridge' with { 'resolution-mode': 'import' };
import { PLUGIN_NAME, PLATFORM_NAME } from './config';
import { PowerpackPlatform } from './platform';

// A CommonJS function works with both Homebridge 1.x and 2.x plugin loaders.
export = function register(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PowerpackPlatform);
};
