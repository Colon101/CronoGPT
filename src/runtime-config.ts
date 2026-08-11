import { parseConfiguredAllowedOrigins } from "./http-security.js";

type Environment = Record<string, string | undefined>;

export function isInsecureDevNoAuthAllowed(env: Environment = process.env) {
  return env.NODE_ENV?.trim() !== "production"
    && env.CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH?.trim() === "true"
    && env.CRONOMETER_BACKEND?.trim() === "mock"
    && env.CRONOMETER_ENABLE_WRITES?.trim() === "false";
}

export function validateRuntimeConfiguration(env: Environment = process.env) {
  const issues: string[] = [];
  const production = env.NODE_ENV?.trim() === "production";
  const publicOrigin = env.APP_PUBLIC_ORIGIN?.trim();

  if (publicOrigin) {
    try {
      const url = new URL(publicOrigin);
      const normalizedOrigin = url.origin;
      const normalizedInput = publicOrigin.replace(/\/+$/, "");
      if (!/^https?:$/.test(url.protocol) || normalizedInput !== normalizedOrigin) {
        issues.push("APP_PUBLIC_ORIGIN must be a bare HTTP(S) origin without a path, query, fragment, or credentials.");
      }
      if (production && url.protocol !== "https:") {
        issues.push("APP_PUBLIC_ORIGIN must use HTTPS in production.");
      }
    } catch {
      issues.push("APP_PUBLIC_ORIGIN must be a valid absolute HTTP(S) origin.");
    }
  } else if (production) {
    issues.push("APP_PUBLIC_ORIGIN is required in production so OAuth does not trust caller-controlled forwarding headers.");
  }

  const configuredAllowedOrigins = parseConfiguredAllowedOrigins(env.CRONOGPT_ALLOWED_ORIGINS);
  if (configuredAllowedOrigins.invalid.length > 0) {
    issues.push(`CRONOGPT_ALLOWED_ORIGINS entries must each be a bare HTTP(S) origin; invalid: ${configuredAllowedOrigins.invalid.join(", ")}.`);
  }

  const apiToken = env.CRONOGPT_API_TOKEN?.trim();
  const linkSecret = env.CRONOGPT_LINK_SECRET?.trim();
  if (production && (!apiToken || apiToken.length < 32)) {
    issues.push("CRONOGPT_API_TOKEN must contain at least 32 characters in production.");
  }
  if (production && (!linkSecret || linkSecret.length < 24)) {
    issues.push("CRONOGPT_LINK_SECRET must contain at least 24 characters in production.");
  }
  if (production && apiToken && linkSecret && apiToken === linkSecret) {
    issues.push("CRONOGPT_LINK_SECRET must differ from CRONOGPT_API_TOKEN in production.");
  }
  const oauthStateFile = env.CRONOGPT_OAUTH_STATE_FILE?.trim();
  if (production && (!oauthStateFile || !oauthStateFile.startsWith("/"))) {
    issues.push("CRONOGPT_OAUTH_STATE_FILE must be an absolute persistent path in production.");
  }

  const insecureDevNoAuth = env.CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH?.trim();
  if (insecureDevNoAuth && !["true", "false"].includes(insecureDevNoAuth)) {
    issues.push('CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH must be either "true" or "false".');
  }
  if (insecureDevNoAuth === "true") {
    if (production) {
      issues.push("CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH cannot be enabled in production.");
    }
    if (env.CRONOMETER_BACKEND?.trim() !== "mock") {
      issues.push("CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH requires CRONOMETER_BACKEND=mock.");
    }
    if (env.CRONOMETER_ENABLE_WRITES?.trim() !== "false") {
      issues.push("CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH requires CRONOMETER_ENABLE_WRITES=false.");
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid cronogpt runtime configuration: ${issues.join(" ")}`);
  }
  return {
    production,
    publicOrigin,
    authConfigured: Boolean(apiToken),
    separateLinkSecretConfigured: Boolean(linkSecret && linkSecret !== apiToken),
    oauthStateFile,
    allowedOrigins: configuredAllowedOrigins.origins,
    insecureDevNoAuth: isInsecureDevNoAuthAllowed(env),
  };
}
