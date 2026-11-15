// Sets the theme before first paint: the stored choice, else the system's. site.js owns the toggle.
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem('theme');
  } catch {
    // storage is blocked: follow the system
  }
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
})();
