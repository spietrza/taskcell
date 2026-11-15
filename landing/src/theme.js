// The theme and the language, on every page: set before first paint (the stored choice, else the system's), then the
// button in the bar flips and stores it. A plain script in the head, so there is no flash of the other theme.
// It is a file, not an inline script, because the CSP allows scripts from 'self' only.
(() => {
  const root = document.documentElement;
  const GROUND = { dark: '#0d1013', light: '#f4f2ed' }; // --bg of each theme in site.css, for the browser's own chrome
  const apply = (theme) => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', GROUND[theme]);
  };
  let stored = null;
  try {
    stored = localStorage.getItem('theme');
  } catch {
    // storage is blocked: follow the system
  }
  const system = matchMedia('(prefers-color-scheme: light)');
  const chosen = () => stored === 'light' || stored === 'dark';
  apply(chosen() ? stored : system.matches ? 'light' : 'dark');
  // Nothing stored: the page follows the system live, too.
  system.addEventListener('change', () => !chosen() && apply(system.matches ? 'light' : 'dark'));

  // Language, on the same early run: a browser that prefers Polish goes to the page's Polish version, but only while
  // nothing is stored. The EN / PL switch stores the choice, so a visitor who chose is never sent anywhere. Only an
  // English page with a Polish alternate redirects, and never back, so a crawler cannot loop.
  let lang = null;
  try {
    lang = localStorage.getItem('lang');
  } catch {
    // storage is blocked: detect on every visit
  }
  const polish = document.querySelector('link[rel="alternate"][hreflang="pl"]');
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if (!lang && polish && root.lang === 'en' && /^pl\b/i.test(first)) {
    location.replace(new URL(polish.href).pathname + location.search + location.hash);
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const a of document.querySelectorAll('.langs a')) {
      a.addEventListener('click', () => {
        try {
          localStorage.setItem('lang', a.hreflang);
        } catch {
          // storage is blocked: the choice lasts for this page
        }
      });
    }
    const button = document.getElementById('theme');
    if (!button) return;
    const paint = () => button.setAttribute('aria-pressed', root.dataset.theme === 'light');
    button.hidden = false;
    button.addEventListener('click', () => {
      apply(root.dataset.theme === 'light' ? 'dark' : 'light');
      try {
        stored = root.dataset.theme;
        localStorage.setItem('theme', stored);
      } catch {
        // storage is blocked: the choice lasts for this page
      }
      paint();
    });
    paint();
  });
})();
