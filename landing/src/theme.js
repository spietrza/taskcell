// The theme, on every page: set before first paint (the stored choice, else the system's), then the
// button in the bar flips and stores it. A plain script in the head, so there is no flash of the other theme.
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
  apply(stored === 'light' || stored === 'dark' ? stored : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme');
    if (!button) return;
    const paint = () => button.setAttribute('aria-pressed', root.dataset.theme === 'light');
    button.hidden = false;
    button.addEventListener('click', () => {
      apply(root.dataset.theme === 'light' ? 'dark' : 'light');
      try {
        localStorage.setItem('theme', root.dataset.theme);
      } catch {
        // storage is blocked: the choice lasts for this page
      }
      paint();
    });
    paint();
  });
})();
