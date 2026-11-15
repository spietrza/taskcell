// The independent security scores shown under Security: the page carries the last known value as text in
// <span data-score="<name>">, and the Worker swaps in the live one from the issuer. Only the names below are
// fetched, each answer is cached for a day, and a value that does not match its shape is dropped (the page
// keeps its own text), so an issuer can never put markup or a long string on the page.
const SCORES = {
  scorecard: {
    url: 'https://api.scorecard.dev/projects/github.com/spietrza/taskcell',
    read: (json) => (typeof json?.score === 'number' && json.score >= 0 && json.score <= 10 ? json.score.toFixed(1) : undefined),
  },
  bestpractices: {
    url: 'https://www.bestpractices.dev/projects/16734.json',
    read: (json) => (['in_progress', 'passing', 'silver', 'gold'].includes(json?.badge_level) ? json.badge_level.replace('_', ' ') : undefined),
  },
  observatory: {
    url: 'https://img.shields.io/mozilla-observatory/grade/taskcell.dev.json',
    read: (json) => (typeof json?.value === 'string' && /^[A-F][+-]?$/.test(json.value) ? json.value : undefined),
  },
};

/** The live value of one score, or undefined when the name is unknown or the issuer did not answer as expected. */
export async function scoreValue(name) {
  const score = Object.hasOwn(SCORES, name) ? SCORES[name] : undefined;
  if (score === undefined) return undefined;
  try {
    const res = await fetch(score.url, { cf: { cacheTtl: 86400, cacheEverything: true }, headers: { accept: 'application/json' } });
    return res.ok ? score.read(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}
