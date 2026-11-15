// Checks the readiness quiz's rules: node quiz-check.mjs (no dependencies, no browser).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PASS, PRICES, YEARLY, euro } from './src/prices.js';
import { evaluate } from './src/quiz.js';

const base = { host: 'github', tests: 'always', criteria: 'always', team: '2-5', models: ['claude'], review: 'team' };
const COST = 'Every run records its tokens, cache use and cost.';

const ready = evaluate(base);
assert.equal(ready.level, 'Ready');
assert.deepEqual(ready.fixes, []);
assert.equal(ready.alt, '');
assert.equal(ready.plan.id, 'team');
assert.match(ready.plan.name, /Team, €39/);
assert.match(ready.plan.note, /31\.20/);

const almost = evaluate({ ...base, tests: 'sometimes', criteria: 'sometimes', team: '1' });
assert.equal(almost.level, 'Almost ready');
assert.equal(almost.fixes.length, 2);
assert.match(almost.alt, /7-day Solo pass for €8/);
assert.match(almost.plan.name, /Solo, €14/);
assert.match(almost.plan.note, /11\.20/);

const noModel = evaluate({ ...base, models: [] });
assert.equal(noModel.level, 'Almost ready');
assert.ok(!noModel.promises.some((p) => p.includes('your own keys')));

for (const a of [{ ...base, tests: 'none', team: '6-10' }, { ...base, host: 'other', team: '6-10' }]) {
  const r = evaluate(a);
  assert.equal(r.level, 'Foundations first');
  assert.match(r.alt, /self-host for €0/);
  assert.match(r.plan.name, /Pro, €79/);
  assert.match(r.plan.note, /63\.20/);
}

const more = evaluate({ ...base, team: 'more' });
assert.equal(more.plan.id, null);
assert.match(more.plan.name, /talk to us/);

assert.ok(evaluate({ ...base, models: ['claude', 'codex'] }).promises.includes(COST));
assert.ok(!evaluate({ ...base, models: ['codex'] }).promises.includes(COST));
assert.ok(evaluate({ ...base, review: 'auto' }).promises.some((p) => p.includes('reviewer')));

for (const tests of ['always', 'sometimes', 'none'])
  for (const models of [[], ['codex'], ['claude', 'api', 'openrouter', 'codex']])
    for (const review of ['me', 'auto']) {
      const n = evaluate({ ...base, tests, models, review }).promises.length;
      assert.ok(n >= 3 && n <= 4, `3 to 4 promises, got ${n}`);
    }

// "Ready" never comes with something to fix first.
const sometimes = evaluate({ ...base, criteria: 'sometimes' });
assert.equal(sometimes.level, 'Almost ready');
assert.equal(sometimes.fixes.length, 1);
for (const host of ['github', 'gitlab', 'other'])
  for (const tests of ['always', 'sometimes', 'none'])
    for (const criteria of ['always', 'sometimes', 'no'])
      for (const models of [[], ['claude']]) {
        const r = evaluate({ ...base, host, tests, criteria, models });
        assert.equal(r.level === 'Ready', r.fixes.length === 0, `${host}/${tests}/${criteria}: Ready only with nothing to fix`);
      }

// Prices: src/prices.js is the source; every plain-text copy on the site must say the same.
const read = (file) => readFileSync(new URL(`./src/${file}`, import.meta.url), 'utf8');
const [home, request, llms] = ['index.html', 'hosting/index.html', 'llms.txt'].map(read);
const typed = [...home.matchAll(/data-price="(\d+)"><span>€(\d+)<\/span>/g)].map((m) => [Number(m[1]), Number(m[2])]);
assert.deepEqual(typed, Object.values(PRICES).map((n) => [n, n]), 'plan cards in index.html');
assert.ok(home.includes(`hosting is planned, from ${euro(PRICES.solo)} a month`), 'hero line in index.html');
assert.ok(home.includes(`7-day Solo pass, ${euro(PASS)}.</b> If you stay, the ${euro(PASS)} is credited`), 'pass in index.html');
assert.ok(home.includes(`Yearly, ${Math.round((1 - YEARLY) * 100)}% off`), 'yearly switch in index.html');
for (const [id, name] of [['solo', 'Solo'], ['team', 'Team'], ['pro', 'Pro']]) {
  assert.ok(request.includes(`<option value="${id}">${name}, ${euro(PRICES[id])} a month`), `${name} option in hosting/index.html`);
  assert.ok(llms.includes(`${name} (EUR ${PRICES[id]}`), `${name} in llms.txt`);
}
assert.ok(request.includes(`7-day Solo pass, ${euro(PASS)}</option>`), 'pass option in hosting/index.html');
assert.ok(llms.includes(`7-day Solo pass (EUR ${PASS})`), 'pass in llms.txt');

console.log('quiz rules and prices ok');
