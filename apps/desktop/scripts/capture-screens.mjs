// Screenshot demo-mode addresses of the dev server: node capture-screens.mjs <outDir> <urlsJson> <WxH,...json>
// Refuses any address that is not the local dev server in demo mode, so a capture never reaches a hub.
import { chromium } from '@playwright/test';
import { join } from 'node:path';

const [out, urlsJson, sizesJson] = process.argv.slice(2);
const urls = JSON.parse(urlsJson);
const sizes = JSON.parse(sizesJson);
for (const u of urls) {
  const url = new URL(u);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.searchParams.get('demo') !== '1') {
    throw new Error(`refusing to capture a non-demo address: ${url.origin}`);
  }
}
const browser = await chromium.launch();
try {
  for (const u of urls) {
    const screen = new URL(u).searchParams.get('screen') ?? 'home';
    for (const size of sizes) {
      const [width, height] = size.split('x').map(Number);
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(u, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(out, `${screen}-${width}.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
