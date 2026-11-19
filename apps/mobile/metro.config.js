// The shared hub client lives outside this app (packages/hub-client) and uses NodeNext-style `./x.js`
// specifiers for `.ts` files; let Metro watch that folder and resolve those to the TypeScript source.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const hubClient = path.resolve(__dirname, '../../packages/hub-client');
const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), hubClient];
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const target = context.originModulePath.startsWith(hubClient) && name.startsWith('.') && name.endsWith('.js') ? name.slice(0, -3) : name;
  return (resolveRequest ?? context.resolveRequest)(context, target, platform);
};
module.exports = config;
