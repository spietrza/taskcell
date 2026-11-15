// /badges/<name>.svg: the live security badges, fetched from their issuers and served from this origin, because
// the page's CSP allows images from 'self' only. Only the names below are fetched (no open proxy), the issuer's
// answer is cached for a day, and the SVG is served with a CSP of its own so a script in it cannot run here.
const ISSUERS = {
  scorecard: () => 'https://api.scorecard.dev/projects/github.com/spietrza/taskcell/badge',
  observatory: () => 'https://img.shields.io/mozilla-observatory/grade/taskcell.dev',
  bestpractices: (env) => (/^\d+$/.test(env.BESTPRACTICES_ID ?? '') ? `https://www.bestpractices.dev/projects/${env.BESTPRACTICES_ID}/badge` : undefined),
  ci: () => 'https://github.com/spietrza/taskcell/actions/workflows/ci.yml/badge.svg',
  owasp: () => 'https://img.shields.io/badge/OWASP%20Agentic%20Top%2010-self--assessed-0F766E',
  license: () => 'https://img.shields.io/badge/license-MIT-8B5CF6',
  node: () => 'https://img.shields.io/badge/node-%E2%89%A5%2024-22D3EE',
  typescript: () => 'https://img.shields.io/badge/TypeScript-strict-3178C6',
  sdk: () => 'https://img.shields.io/badge/built%20with-Claude%20Agent%20SDK-D97757',
  docker: () => 'https://img.shields.io/badge/sandboxed-Docker-2496ED',
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
