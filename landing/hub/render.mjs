// Renders the Hub section from the app's own components. node build.mjs calls renderHub():
//  1. apps/desktop/src/dev/landingScene.tsx runs in jsdom under Vite: the real App, on the demo project's Board with
//     a card's quick view open, from the demo fixtures. The result is static markup plus the stage line frames.
//  2. Tailwind compiles the app's tokens (apps/desktop/src/tokens.css) and the utilities that markup uses, nothing else.
//  3. The tokens are moved from :root to .hub-app and from the app's `.dark` class to the page's data-theme, so the
//     section follows the page theme; inline styles become classes, because the page's CSP forbids style attributes.
// No React reaches the page: the output is HTML and CSS. It needs apps/desktop's dependencies (pnpm --dir apps/desktop install).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '../../apps/desktop');
const work = join(here, '../.hub');
const DARK = ':root[data-theme=dark]';

/** The scene's markup and a template per stage line step, ready for index.html. */
function markup(scene) {
  const stages = scene.stages.map((s, i) => `<template data-hub-step="${i}">${s.html}</template>`).join('');
  return { html: `${scene.app}${stages}`, scan: `${scene.app}${scene.stages.map((s) => s.html).join('')}` };
}

/** Style attributes (a project's colour dot, Base UI's hidden input) become classes: the CSP allows no inline style. */
function unstyle(html) {
  const rules = new Map();
  const out = html.replace(/<([a-z0-9]+)\b([^>]*?) style="([^"]*)"([^>]*)>/g, (m, tag, a, style, b) => {
    if (tag === 'input' && /aria-hidden="true"/.test(a + b)) return `<${tag}${a}${b} hidden>`; // Base UI's hidden form mirror
    if (!rules.has(style)) rules.set(style, `hub-s${rules.size}`);
    const cls = rules.get(style);
    return /\bclass="/.test(a + b) ? `<${tag}${a}${b}>`.replace(/class="/, `class="${cls} `) : `<${tag} class="${cls}"${a}${b}>`;
  });
  const css = [...rules].map(([style, cls]) => `.hub-app .${cls}{${style.replace(/;\s*$/, '')}}`).join('');
  return { html: out, css };
}

/** Compiled CSS scoped to the section: tokens on .hub-app, the app's dark class replaced by the page's data-theme. */
function scope(css) {
  const out = css
    .replaceAll(':root,:host{', '.hub-app{')
    .replaceAll(':root:not(.dark){', `:root:not([data-theme=dark]) .hub-app{`)
    .replaceAll(':root{', '.hub-app{')
    .replaceAll('.dark{', `${DARK} .hub-app{`)
    .replaceAll(':is(.dark *)', `:is(${DARK} *)`)
    .replaceAll(':not(.dark)', ':not([data-theme=dark])');
  const rest = out.replaceAll(':root[data-theme=dark]', '').replaceAll(':root:not([data-theme=dark])', '');
  if (/:root|:host|\.dark(?![\\:\w-])|(^|[,}])\s*(html|body)\b/.test(rest))
    throw new Error('hub/render.mjs: the compiled CSS has a selector that would reach the page; extend scope()');
  return out;
}

export async function renderHub() {
  if (!existsSync(join(desktop, 'node_modules', 'react'))) {
    throw new Error('The Hub section is rendered from apps/desktop, which is not installed: run `pnpm --dir apps/desktop install --frozen-lockfile` first.');
  }
  const require = createRequire(join(desktop, 'package.json'));
  const { JSDOM } = require('jsdom');
  const { build, createServer } = require('vite');
  const tailwind = require('@tailwindcss/vite').default;

  // jsdom stands in for the browser while the app renders.
  const dom = new JSDOM('<!doctype html><html class="dark"><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map();
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in globalThis && key !== 'window' && key !== 'document' && key !== 'navigator') continue;
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    try { Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true }); } catch { /* read-only on this Node */ }
  }
  for (const key of ['window', 'document', 'navigator']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let scene;
  const server = await createServer({ root: desktop, configFile: join(desktop, 'vite.config.ts'), server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
  try {
    scene = await (await server.ssrLoadModule('/src/dev/landingScene.tsx')).renderHubScene();
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // calls the app had in flight settle while the module server is still up
    await server.close();
    dom.window.close();
    for (const [key, desc] of saved) desc ? Object.defineProperty(globalThis, key, desc) : delete globalThis[key];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }

  const { html, scan } = markup(scene);
  const styled = unstyle(html);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'scan.html'), scan);
  writeFileSync(join(work, 'chunks-theme.css'), readFileSync(require.resolve('chunks-ui/theme.css'), 'utf8').replace(/^@source .*$/m, '')); // its @source would scan the whole kit
  writeFileSync(join(work, 'hub.css'), [
    `@import '${desktop}/node_modules/tailwindcss/theme.css';`,
    `@import '${desktop}/node_modules/tailwindcss/utilities.css' source(none);`,
    "@import './chunks-theme.css';",
    `@import '${desktop}/src/tokens.css';`,
    `@plugin '${desktop}/node_modules/@tailwindcss/typography';`,
    "@source './scan.html';",
  ].join('\n'));
  const built = await build({ root: work, configFile: false, logLevel: 'error', plugins: [tailwind()], build: { write: false, cssMinify: true, rollupOptions: { input: join(work, 'hub.css') } } });
  const asset = (Array.isArray(built) ? built : [built]).flatMap((o) => o.output).find((f) => f.fileName.endsWith('.css'));
  const css = `${readFileSync(join(here, 'base.css'), 'utf8')}${scope(String(asset.source))}${styled.css}\n`;
  return { html: styled.html, css, scene };
}
