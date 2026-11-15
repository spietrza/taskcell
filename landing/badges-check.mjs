// Checks badges.js: only listed badges are fetched, a non-SVG answer is refused, and the SVG gets its own CSP.
import assert from 'node:assert/strict';
import { handleBadge } from './badges.js';

const calls = [];
const answer = (body, type, status = 200) => async (url) => { calls.push(url); return new Response(body, { status, headers: { 'content-type': type } }); };

globalThis.fetch = answer('<svg/>', 'image/svg+xml');
assert.equal((await handleBadge({}, 'nope')).status, 404);
assert.equal((await handleBadge({}, 'constructor')).status, 404);
assert.equal((await handleBadge({}, 'bestpractices')).status, 404, 'no project id: no badge');
assert.equal((await handleBadge({ BESTPRACTICES_ID: '1;evil' }, 'bestpractices')).status, 404);
assert.equal(calls.length, 0, 'unknown names never reach the network');

const ok = await handleBadge({}, 'scorecard');
assert.equal(ok.status, 200);
assert.equal(ok.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
assert.equal(calls[0], 'https://api.scorecard.dev/projects/github.com/spietrza/taskcell/badge');

await handleBadge({ BESTPRACTICES_ID: '12345' }, 'bestpractices');
assert.equal(calls[1], 'https://www.bestpractices.dev/projects/12345/badge');

for (const name of ['ci', 'owasp', 'license', 'node', 'typescript', 'sdk', 'docker']) assert.equal((await handleBadge({}, name)).status, 200, name);
assert.equal(calls[2], 'https://github.com/spietrza/taskcell/actions/workflows/ci.yml/badge.svg');

globalThis.fetch = answer('<html>', 'text/html');
assert.equal((await handleBadge({}, 'observatory')).status, 502, 'a non-SVG answer is not passed on');
globalThis.fetch = answer('', 'image/svg+xml', 500);
assert.equal((await handleBadge({}, 'observatory')).status, 502);
globalThis.fetch = async () => { throw new Error('down'); };
assert.equal((await handleBadge({}, 'observatory')).status, 502);
console.log('badges-check: ok');
