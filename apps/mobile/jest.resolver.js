// The shared hub client (packages/hub-client) imports its siblings with a `.js` extension (ESM); strip it
// there so Jest finds the `.ts` files. Scoped to that package: every other module resolves as usual.
const HUB_CLIENT = 'packages/hub-client/';

module.exports = (request, options) => {
  const inHubClient = options.basedir.replace(/\\/g, '/').includes(HUB_CLIENT);
  const stripped = inHubClient && /^\.{1,2}\//.test(request) ? request.replace(/\.js$/, '') : request;
  return options.defaultResolver(stripped, options);
};
