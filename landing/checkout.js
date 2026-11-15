// Checkout for the planned hosted plans (GET /checkout?plan=solo|team|pro|pass&period=monthly|yearly): opens a
// Stripe Checkout session in the visitor's currency and sends the browser there. The CHECKOUT variable decides
// who gets one: unset, nobody (the request page answers instead); "test", only links that carry test=1, against
// the Stripe sandbox; "live", everybody, against the live account. Hosting is not open, so it is not "live".

const EUROPE = new Set('AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PT RO RS SE SI SK SM UA VA XK'.split(' '));
const PLANS = ['solo', 'team', 'pro'];

/** Złoty in Poland, euro in the rest of Europe and when the country is unknown, dollars elsewhere. */
export const currencyFor = (country) => (country === 'PL' ? 'pln' : !country || EUROPE.has(country) ? 'eur' : 'usd');

/** "live", "test" or null: whether this request may open a checkout. */
export const checkoutMode = (env, params) => (env.CHECKOUT === 'live' ? 'live' : env.CHECKOUT === 'test' && params.get('test') === '1' ? 'test' : null);

async function stripe(key, path, form) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}` },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) throw new Error(`Stripe ${path.split('?')[0]} answered ${res.status}`);
  return res.json();
}

export async function handleCheckout(request, env, url) {
  const q = url.searchParams;
  const plan = q.get('plan');
  const home = q.get('lang') === 'pl' ? '/pl' : '';
  const mode = checkoutMode(env, q);
  const lookup = plan === 'pass' ? 'solo_pass' : PLANS.includes(plan) ? `${plan}_${q.get('period') === 'yearly' ? 'yearly' : 'monthly'}` : null;
  const requestPage = new URL(`${home}/hosting/${lookup ? `?plan=${plan}` : ''}`, url);
  if (!mode || !lookup) return Response.redirect(requestPage.toString(), 302);

  const live = mode === 'live';
  const key = live ? env.STRIPE_KEY_LIVE : env.STRIPE_KEY_TEST;
  const back = `${url.origin}${home}/hosting/?paid=${plan}${live ? '' : '&test=1'}`;
  const form = {
    mode: plan === 'pass' ? 'payment' : 'subscription',
    'line_items[0][quantity]': '1',
    currency: currencyFor(request.cf?.country),
    'automatic_tax[enabled]': 'true',
    'tax_id_collection[enabled]': 'true',
    billing_address_collection: 'required',
    // The pass comes back with its session id, which is what lets the later subscription reuse the same customer.
    success_url: plan === 'pass' ? `${back}&session={CHECKOUT_SESSION_ID}` : back,
    cancel_url: `${url.origin}${home}/#pricing`,
  };
  if (plan === 'pass') form.customer_creation = 'always';
  // Coming from a paid pass: the same Stripe customer, so the pass credit on their balance comes off this invoice.
  const pass = q.get('pass') && (await env.ORDERS.prepare("SELECT customer, currency FROM orders WHERE session_id = ? AND price = 'solo_pass' AND livemode = ?").bind(q.get('pass'), live ? 1 : 0).first());
  if (pass?.customer) Object.assign(form, { customer: pass.customer, currency: pass.currency, 'customer_update[address]': 'auto', 'customer_update[name]': 'auto' });
  try {
    const prices = await stripe(key, `prices?lookup_keys[]=${lookup}&limit=1`);
    form['line_items[0][price]'] = prices.data[0].id;
    const session = await stripe(key, 'checkout/sessions', form);
    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error(err);
    return Response.redirect(requestPage.toString(), 302);
  }
}
