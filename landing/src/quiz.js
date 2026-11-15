// The readiness quiz's rules, kept apart from the page so `node quiz-check.mjs` can run them without a browser.
// Every promise below must stay true on main: see README.md (Security, MIT), docs/autonomous-loop.md
// (Retrospective memory) and src/agents/codex.ts (Codex reports tokens but no cost).
import { PASS, PRICES, YEARLY, euro } from './prices.js';

const plan = (id, name, limits) => ({
  id,
  name: `${name}, ${euro(PRICES[id])} a month`,
  note: `${limits} ${euro(PRICES[id] * YEARLY)} a month when billed yearly.`,
  action: `Request ${name}`,
});
const PLANS = {
  1: plan('solo', 'Solo', '1 run at a time, 1 person.'),
  '2-5': plan('team', 'Team', '3 runs at a time, no limit on people.'),
  '6-10': plan('pro', 'Pro', '6 runs at a time, no limit on people.'),
  more: { id: null, name: 'More than 10 people: talk to us', note: 'The planned plans stop at 6 runs at a time. Tell us what you need.', action: 'Open an issue on GitHub' },
};

/**
 * Turns the quiz answers into the result screen's content. "Ready" always comes with an empty fix list.
 * @param {{ host: string, tests: string, criteria: string, team: string, models: string[], review: string }} a
 *   `models` without the "none yet" answer: an empty list means no model yet.
 */
export function evaluate(a) {
  const hosted = a.host === 'github' || a.host === 'gitlab';
  const fixes = [
    !hosted && 'Taskcell opens pull requests on GitHub and GitLab. Other code hosts are not supported.',
    a.tests === 'none' && 'The factory checks its work with your tests. Without tests there is nothing to check against.',
    a.tests === 'sometimes' && 'With a red main branch every run fails its gates and lands as a draft. Fix main first.',
    a.criteria !== 'always' && 'Add acceptance criteria to your issues. A card too vague to build goes back as needs info.',
    !a.models.length && 'You need a model plan or key. Taskcell runs on your own.',
  ].filter(Boolean);
  const level = !hosted || a.tests === 'none' ? 'Foundations first' : fixes.length ? 'Almost ready' : 'Ready';
  const codexOnly = a.models.length > 0 && a.models.every((m) => m === 'codex');
  const promises = [
    'MIT licensed: you can move the factory to your own server at any time.',
    a.models.length > 0 && 'Planned for hosting: models run on your own keys, with no margin added by us.',
    !codexOnly && 'Every run records its tokens, cache use and cost.',
    a.review === 'auto' && 'A reviewer reads every diff in a fresh context, and it can be a second model.',
    a.tests !== 'none' && 'Agent code runs in a sealed Docker cell, and its edits to CI configuration are dropped.',
    'Lessons from failed runs and review notes are fed into later runs.',
  ].filter(Boolean).slice(0, 4);
  // Not ready yet: the plan stays named, and a cheaper first step goes under it.
  const alt =
    level === 'Foundations first' ? 'Before you pay for anything: self-host for €0 on your own machine and fix the list.'
    : level === 'Almost ready' ? `A cheaper first step: the planned 7-day Solo pass for ${euro(PASS)}, credited toward your first month if you stay.`
    : '';
  return { level, fixes, promises, plan: PLANS[a.team], alt };
}
