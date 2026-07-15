import { BrowserCronometerProvider } from "./browser.js";
import { MockCronometerProvider } from "./mock.js";
import { TerraCronometerProvider } from "./terra.js";
import type { BackendMode, CronometerProvider } from "../domain.js";

type Environment = Record<string, string | undefined>;

const BACKEND_MODES: BackendMode[] = ["mock", "terra", "browser"];

function env(source: Environment, name: string): string | undefined {
  const value = source[name];
  return value && value.trim() ? value.trim() : undefined;
}

function secretEnv(source: Environment, name: string): string | undefined {
  const value = source[name];
  return value && value.trim() ? value : undefined;
}

export function createProviderFromEnv(source: Environment = process.env): CronometerProvider {
  const requestedValue = env(source, "CRONOMETER_BACKEND");
  if (requestedValue && !BACKEND_MODES.includes(requestedValue as BackendMode)) {
    throw new Error(`CRONOMETER_BACKEND must be one of: ${BACKEND_MODES.join(", ")}. Received ${JSON.stringify(requestedValue)}.`);
  }
  const requested = requestedValue as BackendMode | undefined;
  const hasTerra = Boolean(env(source, "TERRA_API_KEY") && env(source, "TERRA_DEV_ID") && env(source, "TERRA_USER_ID"));
  const hasBrowserCredentials = Boolean(
    (env(source, "CRONOMETER_EMAIL") || env(source, "email"))
      && (secretEnv(source, "CRONOMETER_PASSWORD") || secretEnv(source, "password")),
  );
  const timeZone = validatedTimeZone(env(source, "CRONOMETER_TIME_ZONE") ?? "Asia/Jerusalem");

  const mode: BackendMode = requested ?? (hasTerra ? "terra" : hasBrowserCredentials ? "browser" : "mock");

  if (mode === "terra") {
    if (!hasTerra) {
      throw new Error("CRONOMETER_BACKEND=terra requires TERRA_API_KEY, TERRA_DEV_ID, and TERRA_USER_ID.");
    }
    return new TerraCronometerProvider({
      apiBaseUrl: env(source, "TERRA_API_BASE_URL") ?? "https://api.tryterra.co/v2",
      apiKey: env(source, "TERRA_API_KEY") ?? "",
      devId: env(source, "TERRA_DEV_ID") ?? "",
      userId: env(source, "TERRA_USER_ID") ?? "",
      timeZone,
      requestTimeoutMs: numberEnv(source, "TERRA_REQUEST_TIMEOUT_MS", 30000, 1),
    });
  }

  if (mode === "browser") {
    const chromiumExecutablePath = env(source, "CHROME_EXECUTABLE_PATH")
      ?? env(source, "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
    return new BrowserCronometerProvider({
      email: env(source, "CRONOMETER_EMAIL") ?? env(source, "email"),
      password: secretEnv(source, "CRONOMETER_PASSWORD") ?? secretEnv(source, "password"),
      remoteWsEndpoint: env(source, "REMOTE_CHROME_WS_ENDPOINT") ?? env(source, "BROWSERLESS_WS_ENDPOINT"),
      storageState: env(source, "CRONOMETER_STORAGE_STATE_BASE64") ?? env(source, "CRONOMETER_STORAGE_STATE"),
      localChromium: booleanEnv(source, "CRONOMETER_LOCAL_CHROMIUM", false) || Boolean(chromiumExecutablePath),
      chromiumExecutablePath,
      writeEnabled: booleanEnv(source, "CRONOMETER_ENABLE_WRITES", false),
      requireFoodConfirmation: booleanEnv(source, "CRONOMETER_REQUIRE_FOOD_CONFIRMATION", false),
      navigationTimeoutMs: numberEnv(source, "CRONOMETER_NAVIGATION_TIMEOUT_MS", 20000, 1),
      loginBackoffMs: numberEnv(source, "CRONOMETER_LOGIN_BACKOFF_MS", 15 * 60 * 1000, 1),
      loginBackoffFile: env(source, "CRONOMETER_LOGIN_BACKOFF_FILE") ?? ".cronometer-login-backoff.json",
      operationTimeoutMs: numberEnv(source, "CRONOMETER_OPERATION_TIMEOUT_MS", 600000, 1),
      browserRetryCount: numberEnv(source, "CRONOMETER_BROWSER_RETRY_COUNT", 1, 0),
      timeZone,
      browserProfileDir: env(source, "CRONOMETER_BROWSER_PROFILE_DIR"),
      reuseRemoteContext: booleanEnv(source, "CRONOMETER_REUSE_REMOTE_CONTEXT", false),
      reuseLocalBrowser: booleanEnv(source, "CRONOMETER_REUSE_LOCAL_BROWSER", false),
      strictAccountVerification: booleanEnv(source, "CRONOMETER_STRICT_ACCOUNT_VERIFICATION", true),
    });
  }

  return new MockCronometerProvider({ timeZone });
}

function booleanEnv(source: Environment, name: string, fallback: boolean) {
  const value = env(source, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either "true" or "false". Received ${JSON.stringify(value)}.`);
}

function numberEnv(source: Environment, name: string, fallback: number, minimum: number) {
  const raw = env(source, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}. Received ${JSON.stringify(raw)}.`);
  }
  return value;
}

function validatedTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return value;
  } catch {
    throw new Error(`CRONOMETER_TIME_ZONE is not a valid IANA time zone: ${JSON.stringify(value)}.`);
  }
}
