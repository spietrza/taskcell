// The planned hosting prices, in euros: the one place the page's scripts take them from.
// index.html, hosting/index.html and llms.txt repeat them as plain text for readers without JavaScript;
// `node quiz-check.mjs` fails when one of those copies disagrees with this file.

/** Monthly price of each planned plan. */
export const PRICES = { solo: 14, team: 39, pro: 79 };
/** The 7-day Solo pass. */
export const PASS = 8;
/** Paying yearly takes 20% off. */
export const YEARLY = 0.8;

/** "€14" or "€11.20". */
export const euro = (n) => '€' + (Number.isInteger(n) ? n : n.toFixed(2));
