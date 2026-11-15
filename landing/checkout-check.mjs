// Self-check for checkout.js: who gets a checkout, in which currency, and what is asked of Stripe.
import assert from 'node:assert/strict';
import { checkoutMode, currencyFor, handleCheckout } from './checkout.js';
import { AMOUNTS } from './src/prices.js';

assert.deepEqual(['PL', 'DE', 'GB', undefined, 'US', 'JP'].map(currencyFor), ['pln', 'eur', 'eur', 'eur', 'usd', 'usd']);
assert.deepEqual(Object.keys(AMOUNTS), ['eur', 'usd', 'pln'], 'every currency the Worker can pick has prices on the page');

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), form: init.body && Object.fromEntries(init.body) });
  return Response.json(String(url).includes('/prices') ? { data: [{ id: 'price_1' }] } : { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
};
const order = { customer: 'cus_1', currency: 'pln' };
const ORDERS = { prepare: () => ({ bind: (id) => ({ first: async () => (id === 'cs_pass' ? order : null) }) }) };
const go = (query, env, country = 'PL') => {
  const url = new URL(`https://taskcell.dev/checkout?${query}`);
  return handleCheckout(Object.assign(new Request(url), { cf: { country } }), { ORDERS, STRIPE_KEY_TEST: 'sk_test_x', ...env }, url);
};

// Closed by default, and "test" opens only for links that ask for it: the public buttons keep the request page.
assert.equal(checkoutMode({}, new URLSearchParams('test=1')), null);
assert.equal((await go('plan=solo&test=1', {})).headers.get('location'), 'https://taskcell.dev/hosting/?plan=solo');
assert.equal((await go('plan=solo&lang=pl', { CHECKOUT: 'test' })).headers.get('location'), 'https://taskcell.dev/pl/hosting/?plan=solo');
assert.equal((await go('plan=nope&test=1', { CHECKOUT: 'test' })).headers.get('location'), 'https://taskcell.dev/hosting/');
assert.equal(calls.length, 0, 'nothing reaches Stripe while closed');

let res = await go('plan=team&period=yearly&test=1', { CHECKOUT: 'test' }, 'US');
assert.equal(res.status, 303);
assert.match(calls[0].url, /lookup_keys\[\]=team_yearly/);
assert.deepEqual([calls[1].form.mode, calls[1].form.currency, calls[1].form['automatic_tax[enabled]'], calls[1].form.customer_creation], ['subscription', 'usd', 'true', undefined]);

res = await go('plan=pass&lang=pl&test=1', { CHECKOUT: 'test' });
assert.deepEqual([calls[3].form.mode, calls[3].form.currency, calls[3].form.customer_creation], ['payment', 'pln', 'always']);
assert.equal(calls[3].form.success_url, 'https://taskcell.dev/pl/hosting/?paid=pass&test=1&session={CHECKOUT_SESSION_ID}');

await go('plan=solo&pass=cs_pass&test=1', { CHECKOUT: 'test' }, 'DE');
assert.deepEqual([calls[5].form.customer, calls[5].form.currency], ['cus_1', 'pln'], 'a pass buyer keeps their customer and currency');
await go('plan=solo&pass=cs_other&test=1', { CHECKOUT: 'test' }, 'DE');
assert.deepEqual([calls[7].form.customer, calls[7].form.currency], [undefined, 'eur']);
console.log('checkout-check: ok');
