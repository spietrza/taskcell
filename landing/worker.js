// taskcell.dev Worker: sends www.taskcell.dev to the apex (a _redirects file cannot match on the host),
// answers agents that ask for Markdown on the home page with llms.txt,
// writes the visitor's country on <html data-country> for the language detection in theme.js,
// writes the visitor's currency on <html data-currency> and, when a checkout is open, data-checkout (checkout.js),
// writes the live security scores into <span data-score> (badges.js), opens a Stripe checkout on /checkout, takes Stripe's payment events on /stripe/webhook (stripe-webhook.js),
// shows the Product Hunt bar during the launch window, logs each page view with its source (no cookies),
// and serves everything else from dist/, where _headers sets the security and cache headers.
import { checkoutMode, currencyFor, handleCheckout } from './checkout.js';
import { handleStripeWebhook } from './stripe-webhook.js';
import { scoreValue } from './badges.js';

// Product Hunt launch: Tue 2026-11-24 00:01 PT (08:01 UTC), the bar stays up for 48 hours. ?launch=preview shows it any time.
const LAUNCH_START = Date.UTC(2026, 10, 24, 8, 1);
const LAUNCH_END = LAUNCH_START + 48 * 3600 * 1000;

// Where a page view came from: the ref/utm_source parameter, else the referring host. Only the host, never the URL or the IP.
const sourceOf = (request, url) => {
  const tagged = url.searchParams.get('ref') ?? url.searchParams.get('utm_source');
  if (tagged) return tagged.slice(0, 40);
  try {
    return new URL(request.headers.get('referer') ?? '').hostname || 'direct';
  } catch {
    return 'direct';
  }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === 'www.taskcell.dev') {
      url.hostname = 'taskcell.dev';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/stripe/webhook') return handleStripeWebhook(request, env, ctx);
    if (url.pathname === '/checkout') return handleCheckout(request, env, url);
    const wantsMarkdown = (request.headers.get('accept') ?? '').includes('text/markdown');
    if (wantsMarkdown && (url.pathname === '/' || url.pathname === '/index.html')) {
      const md = await env.ASSETS.fetch(new URL('/llms.txt', url));
      const res = new Response(md.body, md);
      res.headers.set('Content-Type', 'text/markdown; charset=utf-8');
      res.headers.set('Vary', 'Accept');
      return res;
    }
    const res = await env.ASSETS.fetch(request);
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
    // theme.js reads the country to offer Polish to a first visit from Poland; prices.js reads the currency.
    const country = request.cf?.country;
    // A page opened with ?checkout=test asks for the sandbox checkout; checkoutMode says whether that is allowed.
    const checkout = checkoutMode(env, new URLSearchParams(url.searchParams.get('checkout') === 'test' ? 'test=1' : ''));
    // One line per page view for Workers Logs (Observability): which page and from where. No cookies, no client script.
    // shortcut: Workers Logs keep 3 days on the Free plan; move to Analytics Engine if we need history.
    console.log(JSON.stringify({ event: 'page_view', path: url.pathname, source: sourceOf(request, url), country: country ?? null }));
    const now = Date.now();
    const launchLive = url.searchParams.get('launch') === 'preview' || (now >= LAUNCH_START && now < LAUNCH_END);
    return new HTMLRewriter().on('#launch', {
      element: (el) => {
        if (launchLive) el.removeAttribute('hidden');
      },
    }).on('html', {
      element: (el) => {
        if (country) el.setAttribute('data-country', country);
        el.setAttribute('data-currency', currencyFor(country));
        if (checkout) el.setAttribute('data-checkout', checkout);
      },
    }).on('[data-score]', {
      // Only pages that show a score wait for it; an unknown or failed value keeps the page's own text.
      element: async (el) => {
        const value = await scoreValue(el.getAttribute('data-score') ?? '');
        if (value !== undefined) el.setInnerContent(value);
      },
    }).transform(res);
  },
};
