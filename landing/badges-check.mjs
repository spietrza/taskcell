// Checks badges.js: only listed scores are fetched, and only a value of the expected shape is passed on.
import assert from 'node:assert/strict';
import { scoreValue } from './badges.js';

const calls = [];
const answer = (body, status = 200) => async (url) => { calls.push(url); return new Response(JSON.stringify(body), { status }); };

globalThis.fetch = answer({ score: 6.8 });
assert.equal(await scoreValue('nope'), undefined);
assert.equal(await scoreValue('constructor'), undefined);
assert.equal(calls.length, 0, 'unknown names never reach the network');

assert.equal(await scoreValue('scorecard'), '6.8');
assert.equal(calls[0], 'https://api.scorecard.dev/projects/github.com/spietrza/taskcell');
globalThis.fetch = answer({ score: 7 });
assert.equal(await scoreValue('scorecard'), '7.0');
globalThis.fetch = answer({ score: '<b>10</b>' });
assert.equal(await scoreValue('scorecard'), undefined, 'a non-number score is dropped');

globalThis.fetch = answer({ badge_level: 'in_progress' });
assert.equal(await scoreValue('bestpractices'), 'in progress');
globalThis.fetch = answer({ badge_level: 'platinum<script>' });
assert.equal(await scoreValue('bestpractices'), undefined);

globalThis.fetch = answer({ value: 'A+' });
assert.equal(await scoreValue('observatory'), 'A+');
globalThis.fetch = answer({ value: 'A+ (great)' });
assert.equal(await scoreValue('observatory'), undefined);

globalThis.fetch = answer({ value: 'A+' }, 500);
assert.equal(await scoreValue('observatory'), undefined, 'an error answer keeps the page text');
globalThis.fetch = async () => { throw new Error('down'); };
assert.equal(await scoreValue('observatory'), undefined);
console.log('badges-check: ok');
