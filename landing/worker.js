// taskcell.dev Worker: sends www.taskcell.dev to the apex (a _redirects file cannot match on the host),
// answers agents that ask for Markdown on the home page with llms.txt,
// and serves everything else from dist/, where _headers sets the security and cache headers.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.taskcell.dev') {
      url.hostname = 'taskcell.dev';
      return Response.redirect(url.toString(), 301);
    }
    const wantsMarkdown = (request.headers.get('accept') ?? '').includes('text/markdown');
    if (wantsMarkdown && (url.pathname === '/' || url.pathname === '/index.html')) {
      const md = await env.ASSETS.fetch(new URL('/llms.txt', url));
      const res = new Response(md.body, md);
      res.headers.set('Content-Type', 'text/markdown; charset=utf-8');
      res.headers.set('Vary', 'Accept');
      return res;
    }
    return env.ASSETS.fetch(request);
  },
};
