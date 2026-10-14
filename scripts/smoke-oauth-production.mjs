#!/usr/bin/env node
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverUrl = new URL(
  process.env.CRONOGPT_SMOKE_URL ??
  `https://${process.env.ORACLE_DOMAIN ?? "cronogpt.129-159-156-186.sslip.io"}/mcp`,
);
const linkSecret = process.env.CRONOGPT_LINK_SECRET?.trim();
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const requestedScopes = ["cronometer:read", "cronometer:write"];
const requestedScope = requestedScopes.join(" ");
const timeoutMs = positiveIntegerEnv("CRONOGPT_OAUTH_SMOKE_TIMEOUT_MS", 30000);
const expectedDiaryDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

if (serverUrl.protocol !== "https:" || serverUrl.pathname.replace(/\/+$/, "") !== "/mcp") {
  throw new Error("CRONOGPT_SMOKE_URL must be the public HTTPS /mcp endpoint.");
}
if (!linkSecret) {
  throw new Error("Missing CRONOGPT_LINK_SECRET.");
}

const origin = serverUrl.origin;
const resourceMetadata = await fetchJson(
  new URL("/.well-known/oauth-protected-resource", origin),
  { headers: { accept: "application/json" } },
  "protected-resource discovery",
);
assertEqual(resourceMetadata.resource, serverUrl.href.replace(/\/+$/, ""), "protected resource identifier");
for (const scope of requestedScopes) assertArrayIncludes(resourceMetadata.scopes_supported, scope, `protected resource scope ${scope}`);
if (!Array.isArray(resourceMetadata.authorization_servers) || resourceMetadata.authorization_servers.length === 0) {
  throw new Error("OAuth smoke failed: protected-resource metadata has no authorization server.");
}

const issuer = endpoint(resourceMetadata.authorization_servers[0], "authorization server issuer");
const authorizationMetadata = await fetchJson(
  new URL("/.well-known/oauth-authorization-server", issuer),
  { headers: { accept: "application/json" } },
  "authorization-server discovery",
);
assertEqual(authorizationMetadata.issuer, issuer.href.replace(/\/+$/, ""), "authorization server issuer metadata");
assertArrayIncludes(authorizationMetadata.code_challenge_methods_supported, "S256", "PKCE method");
assertArrayIncludes(authorizationMetadata.token_endpoint_auth_methods_supported, "none", "public-client token method");
for (const scope of requestedScopes) assertArrayIncludes(authorizationMetadata.scopes_supported, scope, `authorization server scope ${scope}`);

const registrationEndpoint = endpoint(authorizationMetadata.registration_endpoint, "registration endpoint");
const authorizationEndpoint = endpoint(authorizationMetadata.authorization_endpoint, "authorization endpoint");
const tokenEndpoint = endpoint(authorizationMetadata.token_endpoint, "token endpoint");

const registration = await fetchJson(
  registrationEndpoint,
  {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "cronogpt deployment OAuth smoke",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: requestedScope,
    }),
  },
  "dynamic client registration",
  new Set([200, 201]),
);
if (typeof registration.client_id !== "string" || registration.client_id.length < 16) {
  throw new Error("OAuth smoke failed: dynamic registration returned no usable client_id.");
}
assertArrayIncludes(registration.redirect_uris, redirectUri, "registered redirect URI");
assertEqual(registration.token_endpoint_auth_method, "none", "registered token endpoint auth method");

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(24).toString("base64url");
const authorizeParams = new URLSearchParams({
  response_type: "code",
  client_id: registration.client_id,
  redirect_uri: redirectUri,
  scope: requestedScope,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: resourceMetadata.resource,
});

const authorizeFormUrl = new URL(authorizationEndpoint);
authorizeFormUrl.search = authorizeParams.toString();
const authorizeForm = await fetch(authorizeFormUrl, requestOptions({
  headers: { accept: "text/html" },
  redirect: "manual",
}));
if (authorizeForm.status !== 200) {
  throw new Error(`OAuth smoke failed: authorization form returned HTTP ${authorizeForm.status}.`);
}
const authorizeHtml = await authorizeForm.text();
if (!authorizeHtml.includes('name="link_secret"') || !authorizeHtml.includes('action="/oauth/authorize"')) {
  throw new Error("OAuth smoke failed: authorization form is missing the link-code submission contract.");
}

const authorizeResponse = await fetch(authorizationEndpoint, requestOptions({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    ...Object.fromEntries(authorizeParams),
    link_secret: linkSecret,
  }),
  redirect: "manual",
}));
if (![302, 303].includes(authorizeResponse.status)) {
  throw new Error(`OAuth smoke failed: authorization submission returned HTTP ${authorizeResponse.status}.`);
}
const redirectLocation = authorizeResponse.headers.get("location");
if (!redirectLocation) {
  throw new Error("OAuth smoke failed: authorization response omitted its redirect.");
}
const callback = new URL(redirectLocation);
const expectedCallback = new URL(redirectUri);
if (callback.origin !== expectedCallback.origin || callback.pathname !== expectedCallback.pathname) {
  throw new Error("OAuth smoke failed: authorization redirected to an unexpected callback.");
}
assertEqual(callback.searchParams.get("state"), state, "authorization state round trip");
const authorizationCode = callback.searchParams.get("code");
if (!authorizationCode) {
  throw new Error("OAuth smoke failed: authorization redirect omitted its code.");
}

const tokenResponse = await fetchJson(
  tokenEndpoint,
  {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: resourceMetadata.resource,
    }),
  },
  "authorization-code exchange",
);
if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) {
  throw new Error("OAuth smoke failed: token exchange returned no access token.");
}
assertEqual(String(tokenResponse.token_type).toLowerCase(), "bearer", "access token type");
for (const scope of requestedScopes) assertArrayIncludes(String(tokenResponse.scope ?? "").split(/\s+/), scope, `granted access-token scope ${scope}`);

const mcpResult = await verifyAuthenticatedMcp(tokenResponse.access_token);
console.log(JSON.stringify({
  ok: true,
  origin,
  checks: {
    protectedResourceDiscovery: true,
    authorizationServerDiscovery: true,
    dynamicClientRegistration: true,
    pkceAuthorization: true,
    authorizationCodeExchange: true,
    authenticatedMcpInitialize: true,
    authenticatedToolCount: mcpResult.toolCount,
    authenticatedReadTool: mcpResult.readTool,
    authenticatedWriteDryRun: mcpResult.writeDryRun,
    authenticatedWidgetResource: mcpResult.widgetResource,
  },
}, null, 2));

async function verifyAuthenticatedMcp(accessToken) {
  const client = new Client({ name: "cronogpt-oauth-production-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "cronometer_capabilities")) {
      throw new Error("OAuth smoke failed: authenticated tools/list omitted cronometer_capabilities.");
    }
    const capabilities = await client.callTool({ name: "cronometer_capabilities", arguments: {} });
    if (capabilities.isError || capabilities.structuredContent?.feature !== "cronometer_capabilities") {
      throw new Error("OAuth smoke failed: authenticated read-only capability call did not succeed.");
    }
    const foodDryRun = await client.callTool({
      name: "log_food",
      arguments: {
        date: "today",
        meal: "Breakfast",
        query: "fresh orange juice",
        amount: 272,
        unit: "g",
        dryRun: true,
        confirmed: false,
      },
    });
    const dryRunData = foodDryRun.structuredContent?.data;
    if (
      foodDryRun.isError
      || foodDryRun.structuredContent?.status !== "dry_run"
      || dryRunData?.browserOpened !== false
      || dryRunData?.writeAttempted !== false
      || dryRunData?.normalized?.date !== expectedDiaryDate
      || dryRunData?.normalized?.meal !== "Breakfast"
      || dryRunData?.normalized?.amount !== 272
      || dryRunData?.normalized?.unit !== "g"
    ) {
      throw new Error("OAuth smoke failed: write-scoped log_food dry-run did not preserve the exact no-write transaction contract.");
    }

    const resources = await client.listResources();
    const widget = resources.resources.find((resource) => resource.uri.startsWith("ui://widget/cronometer-dashboard-v"));
    if (!widget) {
      throw new Error("OAuth smoke failed: authenticated resources/list omitted the versioned dashboard widget.");
    }
    const widgetContents = await client.readResource({ uri: widget.uri });
    if (!widgetContents.contents.some((content) => typeof content.text === "string" && content.text.includes("Cronometer"))) {
      throw new Error("OAuth smoke failed: authenticated dashboard resource read returned no widget markup.");
    }
    return {
      toolCount: tools.tools.length,
      readTool: "cronometer_capabilities",
      writeDryRun: "log_food",
      widgetResource: true,
    };
  } finally {
    await client.close();
  }
}

async function fetchJson(url, init, label, acceptedStatuses = new Set([200])) {
  const response = await fetch(url, requestOptions({ ...init, redirect: "manual" }));
  if (!acceptedStatuses.has(response.status)) {
    throw new Error(`OAuth smoke failed: ${label} returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`OAuth smoke failed: ${label} did not return valid JSON.`);
  }
}

function endpoint(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`OAuth smoke failed: metadata omitted the ${label}.`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new Error(`OAuth smoke failed: ${label} is not on the expected HTTPS origin.`);
  }
  return url;
}

function requestOptions(init) {
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`OAuth smoke failed: ${label} did not match the advertised contract.`);
  }
}

function assertArrayIncludes(value, expected, label) {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error(`OAuth smoke failed: metadata omitted ${label}.`);
  }
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
