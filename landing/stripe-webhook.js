// Stripe webhook for the planned hosted plans (POST /stripe/webhook): checks the signature, records each paid
// checkout once in the ORDERS database, and turns a paid 7-day pass into a customer credit that Stripe takes off
// that customer's first subscription invoice. Starting a server for the order is not built yet: orders stay `paid`.

const TOLERANCE_S = 300;
const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const encoder = new TextEncoder();

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `header` (Stripe-Signature) signs `body` with `secret` and is at most five minutes old. */
export async function signatureIsValid(body, header, secret, nowSeconds = Date.now() / 1000) {
  if (!secret) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !signatures.length || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((s) => sameString(s, expected));
}

async function stripe(key, path, { form, idempotencyKey } = {}) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) throw new Error(`Stripe ${path} answered ${res.status}`);
  return res.json();
}

export async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.text();
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  // Test and live events are signed with different secrets; the unverified flag only picks which one must match.
  const live = event.livemode === true;
  const secret = live ? env.STRIPE_WEBHOOK_SECRET_LIVE : env.STRIPE_WEBHOOK_SECRET_TEST;
  if (!(await signatureIsValid(body, request.headers.get('stripe-signature') ?? '', secret))) {
    return new Response('Bad signature', { status: 400 });
  }
  const session = event.data?.object;
  if (!PAID_EVENTS.includes(event.type) || !session?.id || session.payment_status === 'unpaid') return new Response('ignored');

  const key = live ? env.STRIPE_KEY_LIVE : env.STRIPE_KEY_TEST;
  const items = await stripe(key, `checkout/sessions/${session.id}/line_items?limit=1`);
  const price = items.data?.[0]?.price?.lookup_key ?? null;
  // The session id is the key, so a second delivery of the same checkout adds nothing.
  await env.ORDERS.prepare(
    'INSERT OR IGNORE INTO orders (session_id, event_id, livemode, customer, email, price, subscription, amount_total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(session.id, event.id, live ? 1 : 0, session.customer ?? null, session.customer_details?.email ?? null, price, session.subscription ?? null, session.amount_total ?? null, session.currency ?? null).run();

  const order = await env.ORDERS.prepare('SELECT pass_credited FROM orders WHERE session_id = ?').bind(session.id).first();
  if (price === 'solo_pass' && session.customer && session.amount_total > 0 && !order.pass_credited) {
    // A failure here answers 500, Stripe redelivers, and the idempotency key keeps the credit single.
    await stripe(key, `customers/${session.customer}/balance_transactions`, {
      form: { amount: String(-session.amount_total), currency: session.currency, description: 'Taskcell 7-day pass credited to the first month' },
      idempotencyKey: `pass-credit-${session.id}`,
    });
    await env.ORDERS.prepare('UPDATE orders SET pass_credited = 1 WHERE session_id = ?').bind(session.id).run();
  }
  return new Response('recorded');
}
