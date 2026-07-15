#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  __resetConsumedAuthorizationCodesForTests,
  authorizeMcpRequest,
  handleOAuthRequest,
  isLocalRequest,
} from "../dist/oauth.js";

const originalEnv = { ...process.env };
const origin = "https://cronogpt.example";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const clientId = "cronogpt-test-client";
const verifier = "oauth-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const tempDir = mkdtempSync(join(tmpdir(), "cronogpt-oauth-"));
const oauthStateFile = join(tempDir, "oauth-state.json");

try {
  Object.assign(process.env, {
    APP_PUBLIC_ORIGIN: origin,
    CRONOGPT_API_TOKEN: "oauth-test-api-token",
    CRONOGPT_LINK_SECRET: "oauth-test-link-secret",
    CRONOGPT_OAUTH_STATE_FILE: oauthStateFile,
    CRONOGPT_OAUTH_LOGGING: "0",
    NODE_ENV: "production",
  });

  const spoofedLocal = request("GET", "/mcp", "", { host: "localhost" }, "203.0.113.10");
  assert.equal(isLocalRequest(spoofedLocal), false);
  const actualLocal = request("GET", "/mcp", "", { host: "example.test" }, "127.0.0.1");
  assert.equal(isLocalRequest(actualLocal), true);

  const staticAuth = request("POST", "/mcp", "", {
    authorization: "Bearer oauth-test-api-token",
    host: "cronogpt.example",
  });
  assert.deepEqual(authorizeMcpRequest(staticAuth), {
    ok: true,
    scopes: ["cronometer:read", "cronometer:write"],
    reason: undefined,
  });

  const unsupported = await authorize({
    scope: "cronometer:read unsupported:scope",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.equal(unsupported.status, 400);
  assert.equal(JSON.parse(unsupported.body).error, "invalid_scope");

  const missingPkce = await authorize({ scope: "cronometer:read" });
  assert.equal(missingPkce.status, 400);
  assert.match(JSON.parse(missingPkce.body).error_description, /S256 PKCE/);

  const authorized = await authorize({
    scope: "cronometer:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.location).searchParams.get("code");
  assert.ok(code);

  const missingClient = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert.equal(missingClient.status, 400);

  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert.equal(exchanged.status, 200);
  assert.equal(statSync(oauthStateFile).mode & 0o777, 0o600);
  const tokenBody = JSON.parse(exchanged.body);
  assert.equal(tokenBody.scope, "cronometer:read");

  __resetConsumedAuthorizationCodesForTests();
  const replayed = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert.equal(replayed.status, 400);
  assert.match(JSON.parse(replayed.body).error_description, /already been used/);

  const refreshWithoutClient = await token({
    grant_type: "refresh_token",
    refresh_token: tokenBody.refresh_token,
  });
  assert.equal(refreshWithoutClient.status, 400);

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: tokenBody.refresh_token,
    client_id: clientId,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(JSON.parse(refreshed.body).scope, "cronometer:read");

  const oauthAuth = request("POST", "/mcp", "", {
    authorization: `Bearer ${tokenBody.access_token}`,
    host: "cronogpt.example",
  });
  assert.deepEqual(authorizeMcpRequest(oauthAuth), {
    ok: true,
    scopes: ["cronometer:read"],
    reason: undefined,
  });

  const oversized = response();
  await handleOAuthRequest(
    request("POST", "/oauth/register", "x".repeat(64 * 1024 + 1), { "content-type": "application/json" }),
    oversized,
    new URL(`${origin}/oauth/register`),
  );
  assert.equal(oversized.status, 413);

  console.log("oauth security checks passed");
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  rmSync(tempDir, { force: true, recursive: true });
}

async function authorize(overrides) {
  const body = new URLSearchParams({
    link_secret: "oauth-test-link-secret",
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    ...overrides,
  }).toString();
  const res = response();
  await handleOAuthRequest(
    request("POST", "/oauth/authorize", body, { "content-type": "application/x-www-form-urlencoded" }),
    res,
    new URL(`${origin}/oauth/authorize`),
  );
  return res;
}

async function token(params) {
  const body = new URLSearchParams(params).toString();
  const res = response();
  await handleOAuthRequest(
    request("POST", "/oauth/token", body, { "content-type": "application/x-www-form-urlencoded" }),
    res,
    new URL(`${origin}/oauth/token`),
  );
  return res;
}

function request(method, url, body = "", headers = {}, remoteAddress = "198.51.100.20") {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: "cronogpt.example", ...headers };
  req.socket = { remoteAddress };
  return req;
}

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body = "") {
      this.body += body;
      return this;
    },
  };
}
