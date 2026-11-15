// The planned hosting prices: the one place the page's scripts take them from.
// index.html, hosting/index.html and llms.txt repeat the euro prices as plain text for readers without JavaScript;
// `node quiz-check.mjs` fails when one of those copies disagrees with this file.
// The amounts in each currency are also the prices set in Stripe (lookup keys solo_monthly, …, solo_pass).

/** Monthly price of each planned plan and the 7-day Solo pass, per currency. Prices include VAT. */
export const AMOUNTS = {
  eur: { solo: 14, team: 39, pro: 79, pass: 8 },
  usd: { solo: 16, team: 45, pro: 89, pass: 9 },
  pln: { solo: 59, team: 169, pro: 349, pass: 35 },
};
/** The visitor's currency: the Worker writes it on <html data-currency> from the country; euro without it. */
export const CURRENCY = (typeof document !== 'undefined' && AMOUNTS[document.documentElement.dataset.currency] && document.documentElement.dataset.currency) || 'eur';

const { pass, ...plans } = AMOUNTS[CURRENCY];
/** Monthly price of each planned plan, in the visitor's currency. */
export const PRICES = plans;
/** The 7-day Solo pass, in the visitor's currency. */
export const PASS = pass;
/** Paying yearly takes 20% off. */
export const YEARLY = 0.8;

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
/** "€14" or "€11.20". */
export const euro = (n) => '€' + num(n);
/** An amount in the visitor's currency: "€14", "$16" or "59 zł". */
export const money = (n) => (CURRENCY === 'usd' ? '$' + num(n) : CURRENCY === 'pln' ? num(n) + ' zł' : euro(n));

/** Rewrites the euro prices typed into `el` ("€14" or the Polish "14 €") to the visitor's currency; does nothing for euro. */
export function localise(el) {
  if (CURRENCY === 'eur' || !el) return;
  const swaps = Object.keys(AMOUNTS.eur).map((k) => [new RegExp(`€${AMOUNTS.eur[k]}(?!\\d)|(?<!\\d)${AMOUNTS.eur[k]}\u00a0€`, 'g'), money(AMOUNTS[CURRENCY][k])]);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) for (const [from, to] of swaps) node.data = node.data.replace(from, to);
}
