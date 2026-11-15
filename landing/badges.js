// /badges/<name>.svg: the live security badges, fetched from their issuers and served from this origin, because
// the page's CSP allows images from 'self' only. Only the names below are fetched (no open proxy), the issuer's
// answer is cached for a day, and the SVG is served with a CSP of its own so a script in it cannot run here.
const ISSUERS = {
  scorecard: () => 'https://api.scorecard.dev/projects/github.com/spietrza/taskcell/badge',
  observatory: () => 'https://img.shields.io/mozilla-observatory/grade/taskcell.dev',
  bestpractices: (env) => (/^\d+$/.test(env.BESTPRACTICES_ID ?? '') ? `https://www.bestpractices.dev/projects/${env.BESTPRACTICES_ID}/badge` : undefined),
};

export async function handleBadge(env, name) {
  const source = Object.hasOwn(ISSUERS, name) ? ISSUERS[name](env) : undefined;
  if (source === undefined) return new Response('not found', { status: 404 });
  let upstream;
  try {
    upstream = await fetch(source, { cf: { cacheTtl: 86400, cacheEverything: true }, redirect: 'follow' });
  } catch {
    return new Response('badge unavailable', { status: 502 });
  }
  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !type.includes('image/svg+xml')) return new Response('badge unavailable', { status: 502 });
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
