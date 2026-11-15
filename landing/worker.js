// taskcell.dev Worker: sends www.taskcell.dev to the apex (a _redirects file cannot match on the host),
// answers agents that ask for Markdown on the home page with llms.txt,
// writes the visitor's country on <html data-country> for the language detection in theme.js,
// writes the visitor's currency on <html data-currency> and, when a checkout is open, data-checkout (checkout.js),
// opens a Stripe checkout on /checkout, takes Stripe's payment events on /stripe/webhook (stripe-webhook.js),
// and serves everything else from dist/, where _headers sets the security and cache headers.
import { checkoutMode, currencyFor, handleCheckout } from './checkout.js';
import { handleStripeWebhook } from './stripe-webhook.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.taskcell.dev') {
      url.hostname = 'taskcell.dev';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/stripe/webhook') return handleStripeWebhook(request, env);
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
    return new HTMLRewriter().on('html', {
      element: (el) => {
        if (country) el.setAttribute('data-country', country);
        el.setAttribute('data-currency', currencyFor(country));
        if (checkout) el.setAttribute('data-checkout', checkout);
      },
    }).transform(res);
  },
};
