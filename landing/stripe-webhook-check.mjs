// Self-check for stripe-webhook.js: bad signatures are refused, a repeated delivery records one order,
// and a paid pass is credited once. Runs against an in-memory stand-in for the database and for Stripe.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleStripeWebhook } from './stripe-webhook.js';

const SECRET = 'whsec_test';
const rows = new Map();
const ORDERS = {
  prepare: (sql) => ({
    bind: (...args) => ({
      run: async () => {
        if (sql.startsWith('INSERT') && !rows.has(args[0])) rows.set(args[0], { pass_credited: 0, price: args[5] });
        if (sql.startsWith('UPDATE')) rows.get(args[0]).pass_credited = 1;
      },
      first: async () => rows.get(args[0]),
    }),
  }),
};
const env = { ORDERS, STRIPE_WEBHOOK_SECRET_TEST: SECRET, STRIPE_KEY_TEST: 'sk_test_x' };

const credits = [];
let creditFails = false;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/line_items')) return Response.json({ data: [{ price: { lookup_key: 'solo_pass' } }] });
  if (creditFails) return new Response('down', { status: 500 });
  credits.push(init.body.get('amount'));
  return Response.json({});
};

const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_1', payment_status: 'paid', customer: 'cus_1', amount_total: 800, currency: 'eur' } } });
const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const post = (body, signature) => handleStripeWebhook(new Request('https://taskcell.dev/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': signature } }), env);

assert.equal((await post(event, sign(event, 'whsec_other'))).status, 400, 'a wrong secret is refused');
assert.equal((await post(event, sign(event, SECRET, 1))).status, 400, 'an old timestamp is refused');
assert.equal((await post(event.replace('800', '1'), sign(event))).status, 400, 'a changed body is refused');
assert.equal((await post(event.replace('false', 'true'), sign(event.replace('false', 'true')))).status, 400, 'a live event is not accepted on the test secret');
assert.equal(rows.size, 0);

creditFails = true;
await assert.rejects(post(event, sign(event)), 'a failed credit is not swallowed');
creditFails = false;
assert.equal((await post(event, sign(event))).status, 200);
assert.equal((await post(event, sign(event))).status, 200);
assert.equal(rows.size, 1, 'two deliveries, one order');
assert.deepEqual(credits, ['-800'], 'the pass is credited once');
console.log('stripe-webhook-check: ok');
