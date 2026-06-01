#!/usr/bin/env node
import "dotenv/config";
import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const CRONOMETER_ORIGIN = "https://cronometer.com";
const email = env("CRONOMETER_EMAIL") ?? env("email");
const password = env("CRONOMETER_PASSWORD") ?? env("password");
const headless = env("HEADLESS") !== "false";
const jsonPath = env("CRONOMETER_STORAGE_STATE_JSON_OUT") ?? ".cronometer-storage-state.json";
const base64Path = env("CRONOMETER_STORAGE_STATE_BASE64_OUT") ?? ".cronometer-storage-state.base64";

if (!email || !password) {
  throw new Error("Missing CRONOMETER_EMAIL/CRONOMETER_PASSWORD.");
}

const executablePath = findExecutable();
if (!executablePath) {
  throw new Error("No Chromium/Chrome executable found. Set CHROME_EXECUTABLE_PATH or install chromium.");
}

const browser = await chromium.launch({
  executablePath,
  headless,
  args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(env("CRONOMETER_NAVIGATION_TIMEOUT_MS") ?? 45000));
  page.setDefaultNavigationTimeout(Number(env("CRONOMETER_NAVIGATION_TIMEOUT_MS") ?? 45000));

  await page.goto(`${CRONOMETER_ORIGIN}/#diary`);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500);

  let text = await visibleText(page);
  if (!(await isLoggedIn(text))) {
    await page.goto(`${CRONOMETER_ORIGIN}/login/`);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(800);

    text = await visibleText(page);
    const initialFailure = loginFailureReason(text);
    if (initialFailure) throw new Error(initialFailure);

    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForTimeout(4500);

    text = await visibleText(page);
    if (!(await isLoggedIn(text))) {
      throw new Error(loginFailureReason(text) ?? "Cronometer login did not reach the app. Check credentials, CAPTCHA, or two-factor prompts.");
    }
  }

  const state = await context.storageState();
  const json = JSON.stringify(state);
  writeFileSync(jsonPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(base64Path, Buffer.from(json).toString("base64"), { mode: 0o600 });

  console.log(JSON.stringify({
    ok: true,
    jsonPath,
    base64Path,
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    nextStep: `vercel env add CRONOMETER_STORAGE_STATE_BASE64 production < ${base64Path}`,
  }, null, 2));
} finally {
  await browser.close().catch(() => undefined);
}

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function findExecutable() {
  const configured = env("CHROME_EXECUTABLE_PATH") ?? env("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
  if (configured) return configured;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function visibleText(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isLoggedIn(text) {
  if (/\bWelcome Back\b|\bLOG IN\b|Too Many Attempts|captcha|robot|verify/i.test(text)) return false;
  return /\bDashboard\b|\bDiary\b|\bTrends\b|\bFoods\b/.test(text);
}

function loginFailureReason(text) {
  if (/Too Many Attempts/i.test(text)) {
    return "Cronometer is rate-limiting login attempts: Too Many Attempts. Please try again later.";
  }
  if (/captcha|robot|verify|challenge|cloudflare/i.test(text)) {
    return "Cronometer is showing a bot/CAPTCHA verification challenge.";
  }
  if (/two.factor|2fa|verification code|one-time|one time/i.test(text)) {
    return "Cronometer appears to require a second-factor or verification-code step.";
  }
  if (/invalid|incorrect/i.test(text)) {
    return "Cronometer rejected the configured email or password.";
  }
  return undefined;
}
