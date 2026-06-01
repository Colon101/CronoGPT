import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const AUTH_REALM = "CronoGPT MCP";
const MCP_PATH = "/mcp";
const SCOPES = ["cronometer:read", "cronometer:write"];
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180;
const AUTH_CODE_TTL_SECONDS = 60 * 10;

interface SignedPayload {
  typ: "code" | "access" | "refresh";
  iat: number;
  exp: number;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  aud?: string;
  sub?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  nonce?: string;
}

export function getAuthToken() {
  return process.env.CRONOGPT_API_TOKEN?.trim() || undefined;
}

function getLinkSecret() {
  return process.env.CRONOGPT_LINK_SECRET?.trim() || getAuthToken();
}

export function publicOrigin(req: IncomingMessage) {
  if (process.env.APP_PUBLIC_ORIGIN?.trim()) {
    return process.env.APP_PUBLIC_ORIGIN.trim().replace(/\/+$/, "");
  }

  const forwardedProto = headerValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host = requestHost(req) || "localhost";
  return `${forwardedProto.split(",")[0]}://${host}`.replace(/\/+$/, "");
}

export function resourceIdentifier(req: IncomingMessage) {
  return `${publicOrigin(req)}${MCP_PATH}`;
}

export function requestHost(req: IncomingMessage) {
  const forwardedHost = headerValue(req.headers["x-forwarded-host"]);
  return forwardedHost ?? req.headers.host ?? "";
}

export function isLocalRequest(req: IncomingMessage) {
  const host = requestHost(req).split(":")[0]?.toLowerCase();
  const remote = req.socket.remoteAddress;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1"
  );
}

export function authorizeMcpRequest(req: IncomingMessage) {
  const token = getAuthToken();
  if (!token) {
    return {
      ok: process.env.NODE_ENV !== "production" && isLocalRequest(req),
      reason: "CRONOGPT_API_TOKEN is not configured.",
    };
  }

  const authorization = req.headers.authorization ?? "";
  const [scheme, credential] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) {
    return { ok: false, reason: "Missing bearer token." };
  }

  if (safeEqual(credential, token)) {
    return { ok: true, reason: undefined };
  }

  const payload = verifySignedPayload(credential, "access");
  if (!payload) {
    return { ok: false, reason: "Invalid bearer token." };
  }

  const validAudiences = new Set([resourceIdentifier(req), publicOrigin(req)]);
  if (!payload.aud || !validAudiences.has(payload.aud)) {
    return { ok: false, reason: "Bearer token audience does not match this MCP server." };
  }

  const scopes = new Set((payload.scope ?? "").split(/\s+/).filter(Boolean));
  if (!SCOPES.every((scope) => scopes.has(scope))) {
    return { ok: false, reason: "Bearer token does not include the required CronoGPT scopes." };
  }

  return { ok: true, reason: undefined };
}

export function rejectUnauthorized(req: IncomingMessage, res: ServerResponse, reason: string) {
  const metadataUrl = `${publicOrigin(req)}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    "content-type": "application/json",
    "WWW-Authenticate": `Bearer realm="${AUTH_REALM}", resource_metadata="${metadataUrl}", scope="${SCOPES.join(" ")}"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
  });
  res.end(JSON.stringify({ error: "unauthorized", message: reason }));
}

export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "OPTIONS" && isOAuthPath(url.pathname)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
    });
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    writeJson(res, protectedResourceMetadata(req));
    return true;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    writeJson(res, authorizationServerMetadata(req));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    const body = await readRequestBody(req);
    const registration = body ? parseJsonBody(body) : {};
    writeJson(res, {
      client_id: `cronogpt-${base64Url(randomBytes(18))}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: Array.isArray(registration.redirect_uris) ? registration.redirect_uris : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES.join(" "),
    }, 201);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    renderAuthorizeForm(req, res, Object.fromEntries(url.searchParams.entries()));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/authorize") {
    const params = parseFormBody(await readRequestBody(req));
    handleAuthorizePost(req, res, params);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    const body = await readRequestBody(req);
    const params = req.headers["content-type"]?.includes("application/json")
      ? parseJsonBody(body)
      : parseFormBody(body);
    handleTokenRequest(req, res, params);
    return true;
  }

  return false;
}

function protectedResourceMetadata(req: IncomingMessage) {
  const origin = publicOrigin(req);
  return {
    resource: resourceIdentifier(req),
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    resource_documentation: origin,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function authorizationServerMetadata(req: IncomingMessage) {
  const origin = publicOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: SCOPES,
  };
}

function handleAuthorizePost(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  const linkSecret = getLinkSecret();
  if (!linkSecret) {
    renderAuthorizeForm(req, res, params, "CronoGPT link secret is not configured.", 500);
    return;
  }

  if (!params.link_secret || !safeEqual(params.link_secret, linkSecret)) {
    renderAuthorizeForm(req, res, params, "Invalid CronoGPT link code.", 401);
    return;
  }

  if (params.response_type !== "code" || !params.client_id || !params.redirect_uri) {
    oauthError(res, 400, "invalid_request", "Missing response_type, client_id, or redirect_uri.");
    return;
  }

  if (!isAllowedRedirect(params.redirect_uri, req)) {
    oauthError(res, 400, "invalid_request", "Redirect URI is not allowed.");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const code = signPayload({
    typ: "code",
    iat: now,
    exp: now + AUTH_CODE_TTL_SECONDS,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    scope: normalizeScope(params.scope),
    resource: params.resource || resourceIdentifier(req),
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    nonce: base64Url(randomBytes(18)),
  });

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) {
    redirect.searchParams.set("state", params.state);
  }

  res.writeHead(302, { location: redirect.toString() });
  res.end();
}

function handleTokenRequest(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  if (params.grant_type === "refresh_token") {
    handleRefreshToken(req, res, params);
    return;
  }

  if (params.grant_type !== "authorization_code" || !params.code || !params.redirect_uri) {
    oauthError(res, 400, "invalid_request", "Expected authorization_code grant with code and redirect_uri.");
    return;
  }

  const code = verifySignedPayload(params.code, "code");
  if (!code) {
    oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
    return;
  }

  if (code.redirect_uri !== params.redirect_uri || (params.client_id && code.client_id !== params.client_id)) {
    oauthError(res, 400, "invalid_grant", "Authorization code does not match this token request.");
    return;
  }

  if (code.code_challenge) {
    if (code.code_challenge_method !== "S256" || !params.code_verifier) {
      oauthError(res, 400, "invalid_grant", "PKCE verifier is required.");
      return;
    }
    if (!safeEqual(pkceChallenge(params.code_verifier), code.code_challenge)) {
      oauthError(res, 400, "invalid_grant", "PKCE verifier does not match the authorization code.");
      return;
    }
  }

  writeTokenResponse(req, res, code.client_id, code.scope, code.resource);
}

function handleRefreshToken(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  if (!params.refresh_token) {
    oauthError(res, 400, "invalid_request", "Missing refresh_token.");
    return;
  }

  const refresh = verifySignedPayload(params.refresh_token, "refresh");
  if (!refresh) {
    oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
    return;
  }

  writeTokenResponse(req, res, refresh.client_id, refresh.scope, refresh.aud, false);
}

function writeTokenResponse(
  req: IncomingMessage,
  res: ServerResponse,
  clientId?: string,
  scope = SCOPES.join(" "),
  audience = resourceIdentifier(req),
  includeRefresh = true,
) {
  const now = Math.floor(Date.now() / 1000);
  const normalizedScope = normalizeScope(scope);
  const accessToken = signPayload({
    typ: "access",
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    sub: "cronogpt-owner",
    aud: audience,
    client_id: clientId,
    scope: normalizedScope,
  });
  const response: Record<string, string | number> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: normalizedScope,
  };

  if (includeRefresh) {
    response.refresh_token = signPayload({
      typ: "refresh",
      iat: now,
      exp: now + REFRESH_TOKEN_TTL_SECONDS,
      sub: "cronogpt-owner",
      aud: audience,
      client_id: clientId,
      scope: normalizedScope,
    });
  }

  writeJson(res, response, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
}

function renderAuthorizeForm(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  error?: string,
  status = 200,
) {
  const hidden = Object.entries(params)
    .filter(([key]) => key !== "link_secret")
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("\n");
  const appOrigin = publicOrigin(req);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Link CronoGPT</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101418; color: #f4f7f8; }
      main { max-width: 520px; margin: 12vh auto; padding: 32px; }
      h1 { font-size: 26px; margin: 0 0 12px; }
      p { color: #b9c3c7; line-height: 1.5; }
      label { display: block; font-weight: 650; margin: 24px 0 8px; }
      input[type="password"] { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #3f4a50; background: #171d22; color: #fff; padding: 12px 14px; font-size: 16px; }
      button { margin-top: 18px; border: 0; border-radius: 8px; background: #44b678; color: #06100a; font-weight: 750; padding: 12px 16px; cursor: pointer; }
      .error { color: #ffb4a8; background: #3a1715; padding: 12px; border-radius: 8px; }
      code { color: #d6f3ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Link CronoGPT</h1>
      <p>Enter your private CronoGPT link code to let ChatGPT access <code>${escapeHtml(appOrigin)}</code>. This authorizes ChatGPT to use the Cronometer tools exposed by your MCP server.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/oauth/authorize">
        ${hidden}
        <label for="link_secret">CronoGPT link code</label>
        <input id="link_secret" name="link_secret" type="password" autocomplete="one-time-code" required autofocus />
        <button type="submit">Authorize ChatGPT</button>
      </form>
    </main>
  </body>
</html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function signPayload(payload: SignedPayload) {
  const body = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = hmac(body);
  return `${body}.${signature}`;
}

function verifySignedPayload(token: string, expectedType: SignedPayload["typ"]) {
  const [body, signature] = token.split(".", 2);
  if (!body || !signature || !safeEqual(hmac(body), signature)) return undefined;

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedPayload;
  } catch {
    return undefined;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== expectedType || !payload.exp || payload.exp < now) return undefined;
  return payload;
}

function hmac(value: string) {
  const secret = getAuthToken();
  if (!secret) return "";
  return base64Url(createHmac("sha256", secret).update(value).digest());
}

function pkceChallenge(verifier: string) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function normalizeScope(scope?: string) {
  const requested = new Set((scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean));
  return SCOPES.filter((scopeName) => requested.has(scopeName)).join(" ") || SCOPES.join(" ");
}

function isAllowedRedirect(redirectUri: string, req: IncomingMessage) {
  try {
    const redirect = new URL(redirectUri);
    if (redirect.protocol === "https:" && redirect.hostname === "chatgpt.com") {
      return redirect.pathname.startsWith("/connector/oauth/") || redirect.pathname === "/connector_platform_oauth_redirect";
    }
    return process.env.NODE_ENV !== "production" && isLocalRequest(req) && redirect.hostname === "localhost";
  } catch {
    return false;
  }
}

function isOAuthPath(pathname: string) {
  return pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/oauth");
}

async function readRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFormBody(body: string) {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function parseJsonBody(body: string) {
  try {
    const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

function writeJson(res: ServerResponse, data: unknown, status = 200, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string) {
  writeJson(res, { error, error_description: description }, status, { "Cache-Control": "no-store" });
}

function safeEqual(a: string, b: string) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
