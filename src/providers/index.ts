import { BrowserCronometerProvider } from "./browser.js";
import { MockCronometerProvider } from "./mock.js";
import { TerraCronometerProvider } from "./terra.js";
import type { BackendMode, CronometerProvider } from "../domain.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function createProviderFromEnv(): CronometerProvider {
  const requested = env("CRONOMETER_BACKEND") as BackendMode | undefined;
  const hasTerra = Boolean(env("TERRA_API_KEY") && env("TERRA_DEV_ID") && env("TERRA_USER_ID"));
  const hasBrowserCredentials = Boolean(
    (env("CRONOMETER_EMAIL") || env("email")) && (env("CRONOMETER_PASSWORD") || env("password")),
  );

  const mode: BackendMode = requested ?? (hasTerra ? "terra" : hasBrowserCredentials ? "browser" : "mock");

  if (mode === "terra") {
    if (!hasTerra) {
      return new MockCronometerProvider();
    }
    return new TerraCronometerProvider({
      apiBaseUrl: env("TERRA_API_BASE_URL") ?? "https://api.tryterra.co/v2",
      apiKey: env("TERRA_API_KEY") ?? "",
      devId: env("TERRA_DEV_ID") ?? "",
      userId: env("TERRA_USER_ID") ?? "",
    });
  }

  if (mode === "browser") {
    return new BrowserCronometerProvider({
      email: env("CRONOMETER_EMAIL") ?? env("email"),
      password: env("CRONOMETER_PASSWORD") ?? env("password"),
      remoteWsEndpoint: env("REMOTE_CHROME_WS_ENDPOINT") ?? env("BROWSERLESS_WS_ENDPOINT"),
      storageState: env("CRONOMETER_STORAGE_STATE_BASE64") ?? env("CRONOMETER_STORAGE_STATE"),
      localChromium: env("CRONOMETER_LOCAL_CHROMIUM") === "true" || Boolean(env("CHROME_EXECUTABLE_PATH") || env("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")),
      chromiumExecutablePath: env("CHROME_EXECUTABLE_PATH") ?? env("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
      writeEnabled: env("CRONOMETER_ENABLE_WRITES") === "true",
      requireFoodConfirmation: env("CRONOMETER_REQUIRE_FOOD_CONFIRMATION") === "true",
      navigationTimeoutMs: Number(env("CRONOMETER_NAVIGATION_TIMEOUT_MS") ?? 20000),
      loginBackoffMs: Number(env("CRONOMETER_LOGIN_BACKOFF_MS") ?? 15 * 60 * 1000),
      loginBackoffFile: env("CRONOMETER_LOGIN_BACKOFF_FILE") ?? ".cronometer-login-backoff.json",
      operationTimeoutMs: Number(env("CRONOMETER_OPERATION_TIMEOUT_MS") ?? 600000),
      browserRetryCount: Number(env("CRONOMETER_BROWSER_RETRY_COUNT") ?? 1),
      timeZone: env("CRONOMETER_TIME_ZONE") ?? "Asia/Jerusalem",
      browserProfileDir: env("CRONOMETER_BROWSER_PROFILE_DIR"),
      reuseRemoteContext: env("CRONOMETER_REUSE_REMOTE_CONTEXT") === "true",
      reuseLocalBrowser: env("CRONOMETER_REUSE_LOCAL_BROWSER") === "true",
      strictAccountVerification: env("CRONOMETER_STRICT_ACCOUNT_VERIFICATION") === "true",
    });
  }

  return new MockCronometerProvider();
}
