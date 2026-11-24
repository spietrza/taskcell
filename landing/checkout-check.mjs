// Self-check for checkout.js: who gets a checkout, in which currency, and what is asked of Stripe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// The Worker's page rewrite per CHECKOUT mode, on the built pages (run after build.mjs). Node has no HTMLRewriter, so a
// small one stands in: it knows the selectors worker.js uses (tag, #id, [attr], comma lists) and what its handlers call.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const matches = (sel, tag, attrs) =>
  sel.split(',').map((s) => s.trim()).some((s) =>
    s.startsWith('#') ? attrs.get('id') === s.slice(1) : s.startsWith('[') ? attrs.has(s.slice(1, -1)) : s === tag);
globalThis.HTMLRewriter = class {
  handlers = [];
  on(sel, handler) {
    this.handlers.push([sel, handler]);
    return this;
  }
  transform(res) {
    const run = async () => {
      const html = await res.text();
      let out = '';
      let at = 0;
      let skip = null; // { tag, depth, then }: dropping an element's content up to its end tag
      for (const m of html.matchAll(TOKEN)) {
        const [whole, , close, rawTag, rawAttrs = ''] = m;
        if (!skip) out += html.slice(at, m.index);
        at = m.index + whole.length;
        const tag = rawTag?.toLowerCase();
        if (skip) {
          if (tag === skip.tag) skip.depth += close ? -1 : 1;
          if (skip.depth === 0) {
            out += skip.then;
            skip = null;
          }
          continue;
        }
        if (!tag || close) {
          out += whole;
          continue;
        }
        const attrs = new Map([...rawAttrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
        let removed = false;
        let inner;
        const el = {
          tagName: tag,
          hasAttribute: (n) => attrs.has(n),
          getAttribute: (n) => attrs.get(n) ?? null,
          setAttribute: (n, v) => attrs.set(n, v),
          removeAttribute: (n) => attrs.delete(n),
          remove: () => (removed = true),
          setInnerContent: (c) => (inner = c),
        };
        for (const [sel, h] of this.handlers) if (matches(sel, tag, attrs)) await h.element(el);
        const start = `<${tag}${[...attrs].map(([n, v]) => (v === '' && !rawAttrs.includes(`${n}=`) ? ` ${n}` : ` ${n}="${v}"`)).join('')}>`;
        if (removed) {
          if (!VOID.has(tag)) skip = { tag, depth: 1, then: '' };
        } else if (inner !== undefined) {
          out += start + inner;
          skip = { tag, depth: 1, then: `</${tag}>` };
        } else out += start;
      }
      return out + (skip ? '' : html.slice(at));
    };
    return run().then((body) => new Response(body, res));
  }
};
const { default: worker } = await import('./worker.js');
const dist = new URL('./dist/', import.meta.url);
const ASSETS = {
  fetch: async (req) => {
    const path = new URL(req.url ?? req).pathname.slice(1);
    return new Response(readFileSync(new URL(path.endsWith('/') || path === '' ? `${path}index.html` : path, dist)), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
globalThis.fetch = async () => new Response('', { status: 503 }); // the security scores keep the page's text
const page = async (path, CHECKOUT) => {
  const log = console.log;
  console.log = () => {};
  try {
    const res = await worker.fetch(Object.assign(new Request(`https://taskcell.dev${path}`), { cf: { country: 'DE' } }), { ASSETS, CHECKOUT }, {});
    return await res.text();
  } finally {
    console.log = log;
  }
};
const LIVE = ['data-live', 'Hosting is open', 'Hosting już działa', 'Subscribe to', 'Subskrybuj', 'Buy the', 'Kup 7', 'Payment received', 'Płatność przyjęta', 'Hosted factory ·', 'Fabryka w hostingu ·'];
const PLANNED = ['data-planned', 'Request Solo', 'Poproś o Solo', 'Request a hosted factory', 'Poproś o fabrykę', 'Hosting is planned', 'Hosting w planach', 'not open yet', 'jeszcze nie ruszył',
  'None of this exists yet', 'Nic z tego jeszcze nie istnieje', 'planned price', 'planowaną', '· planned', '· w planach', 'Test payment', 'Płatność testowa', 'placeholder form'];
for (const path of ['/', '/pl/', '/hosting/', '/pl/hosting/']) {
  for (const mode of [undefined, 'test']) {
    const html = await page(path, mode);
    for (const s of LIVE) assert.ok(!html.includes(s), `${path} with CHECKOUT=${mode}: live copy "${s}" is served`);
    assert.ok(html.includes('data-planned') || !path.includes('hosting'), `${path} with CHECKOUT=${mode}: planned copy kept`);
  }
  const live = await page(path, 'live');
  for (const s of PLANNED) assert.ok(!live.includes(s), `${path} with CHECKOUT=live: planned copy "${s}" is served`);
  assert.ok(live.includes('data-checkout="live"'), `${path} with CHECKOUT=live: page marked live`);
}
for (const path of ['/hosting/', '/pl/hosting/']) {
  const planned = await page(path);
  assert.equal(planned.match(/<title[^>]*>/g).length, 1, `${path}: one <title>`);
  assert.equal((await page(path, 'live')).match(/<title[^>]*>/g).length, 1, `${path} live: one <title>`);
  assert.ok(planned.includes('>support@taskcell.dev</a>.</p>'), `${path}: contact address`);
}
assert.ok((await page('/', 'live')).includes('Subscribe to Solo') && (await page('/pl/', 'live')).includes('Subskrybuj Solo'), 'live plan buttons');
console.log('checkout-check: ok');
