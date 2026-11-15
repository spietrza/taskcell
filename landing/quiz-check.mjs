// Checks the readiness quiz's rules: node quiz-check.mjs (no dependencies, no browser).
import assert from 'node:assert/strict';
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

console.log('quiz rules ok');
