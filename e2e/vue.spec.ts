import { test, expect } from '@playwright/test'

// Smoke test: unauthenticated visits land on the sign-in form (the app is
// gated behind a session). Run with `bun run dev` (Vite on 5173).
test('unauthenticated visits show the sign-in form', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in to Miniflux Reader' })).toBeVisible()
})
