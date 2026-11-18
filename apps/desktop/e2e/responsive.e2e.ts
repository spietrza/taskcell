import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const noHorizontalScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
};

test('Home, Waiting for you and run detail fit 390 px', async ({ page }) => {
  await page.goto('/');
  // Home is the landing screen: the command center, then the projects.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible();
  await noHorizontalScroll(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  // The main navigation is a bottom tab bar: below the content, spanning the width.
  const box = await nav.boundingBox();
  expect(box!.y).toBeGreaterThan(400);

  await page.locator('button.proj-open').first().click();
  await nav.getByRole('button', { name: /^Home/ }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible();
  // A waiting item opens to its comment and reply.
  await page.getByRole('button', { name: /^(Review|Answer) / }).first().click();
  await expect(page.getByRole('link', { name: 'Open in GitHub' }).first()).toBeVisible();
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await noHorizontalScroll(page);

  await nav.getByRole('button', { name: 'Runs' }).click();
  // Running rows sort first and open LiveRun (no tabs); the Passed filter leaves only finished runs.
  const main = page.locator('main');
  await main.getByRole('button', { name: /^passed$/i }).click();
  await main.locator('tbody tr').first().click();
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await noHorizontalScroll(page);
});
