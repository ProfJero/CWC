import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Apply the production Content-Security-Policy (public/_headers) to local runs, so CSP problems
// show up before deploying — the local preview server does not send Cloudflare's headers.
const CSP = /Content-Security-Policy: (.+)/.exec(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'))?.[1] ?? '';
test.beforeEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL?.startsWith('https://') || !CSP) return;
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': CSP } });
  });
});

const PW = process.env.E2E_PASSWORD ?? '';
const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

/** Elements wider than the viewport that are not inside a scroll/clip container. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > W + 1) return [`page scrolls horizontally (${document.documentElement.scrollWidth} > ${W})`];
    return [];
  });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_|net::|web push|service worker/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function signIn(page: Page, phone: string) {
  await page.goto('/login');
  await page.getByLabel('Email or phone').fill(phone);
  await page.locator('input[name="password"]').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('visitors (no account needed)', () => {
  for (const path of ['/', '/events', '/devotionals', '/sermons', '/give', '/care', '/care/wall', '/notifications', '/me', '/login', '/signup']) {
    test(`renders ${path} on phones, tablets and desktops without errors`, async ({ page }) => {
      const errors = watchErrors(page);
      for (const vp of VIEWPORTS) {
        await page.setViewportSize(vp);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(await overflow(page), `${path} @ ${vp.width}px`).toEqual([]);
      }
      expect(errors).toEqual([]);
    });
  }

  test('home invites visitors to introduce themselves; admin needs sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('You are welcome here!')).toBeVisible();
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  });

  test('asking for prayer prompts a short profile instead of a sign-up', async ({ page }) => {
    await page.goto('/care/new?type=prayer');
    await page.getByPlaceholder('How can we pray for you?').fill('E2E test — please ignore');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Tell us who you are')).toBeVisible();
    await expect(page.getByLabel('First name')).toBeVisible();
  });
});

test.describe('no-signup journey', () => {
  test('a visitor introduces themselves and sends a prayer request — no password needed', async ({ page }) => {
    test.skip(!process.env.E2E_NEW_PHONE, 'set E2E_NEW_PHONE to an unused test number');
    const errors = watchErrors(page);
    await page.goto('/care/new?type=prayer');
    await page.getByPlaceholder('How can we pray for you?').fill('E2E test — please ignore');
    await page.getByRole('button', { name: 'Send request' }).click();
    await page.getByRole('dialog').getByLabel('First name').fill('E2E Test');
    await page.getByRole('dialog').getByLabel('Last name').fill('Visitor');
    await page.getByRole('dialog').getByLabel('Phone number').fill(process.env.E2E_NEW_PHONE!);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('We’ve received your request')).toBeVisible();
    await page.goto('/me');
    await expect(page.getByRole('heading', { name: 'E2E Test Visitor' })).toBeVisible();
    await expect(page.getByText('Use CWC on another phone?')).toBeVisible();
    await page.goto('/care');
    await expect(page.getByText('E2E test — please ignore').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('members', () => {
  test('a signed-in member sees their profile and can open requests', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, '0209990011');
    await page.goto('/me');
    await expect(page.getByRole('heading', { name: /E2E Test/ })).toBeVisible();
    await page.goto('/care');
    await expect(page.getByText('My requests')).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('members cannot open the staff area', async ({ page }) => {
    await signIn(page, '0209990022');
    await page.goto('/admin');
    await expect(page.getByText('This area is restricted')).toBeVisible();
  });
});

test.describe('staff', () => {
  test('a pastor works through the dashboard, people and care', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, '0209990033');
    for (const path of ['/admin', '/admin/people', '/admin/care', '/admin/follow-ups', '/admin/attendance', '/admin/content', '/admin/events', '/admin/messages']) {
      for (const vp of [VIEWPORTS[1], VIEWPORTS[3]]) {
        await page.setViewportSize(vp);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(await overflow(page), `${path} @ ${vp.width}px`).toEqual([]);
      }
    }
    await page.goto('/admin/people');
    await expect(page.getByText('New in the app')).toBeVisible();
    await page.goto('/admin/users');
    await expect(page.getByText('This area is restricted')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the developer console loads on demand', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, '0209990044');
    await page.goto('/admin/developer');
    await expect(page.getByRole('heading', { name: 'Developer console' })).toBeVisible();
    await expect(page.getByText('Database').first()).toBeVisible();
    await expect(page.getByText(/Snapshot/)).toBeVisible();
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByText('members').first()).toBeVisible();
    await page.goto('/admin/users');
    await page.getByRole('tab', { name: /Roles/ }).click();
    await expect(page.getByRole('button', { name: 'New role' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
