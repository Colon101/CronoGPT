import type { IncomingMessage, ServerResponse } from "node:http";

type Environment = Record<string, string | undefined>;

interface AllowedAuthority {
  protocol: "http:" | "https:";
  host: string;
}

export type RequestAuthorityResult =
  | { ok: true; origin?: string }
  | { ok: false; status: 400 | 403 | 421; message: string };

export function parseConfiguredAllowedOrigins(value: string | undefined) {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of value?.split(",") ?? []) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const origin = parseBareHttpOrigin(candidate);
    if (origin) origins.push(origin);
    else invalid.push(candidate);
  }
  return { origins: Array.from(new Set(origins)), invalid };
}

export function validateRequestAuthority(
  req: Pick<IncomingMessage, "headers" | "url">,
  env: Environment = process.env,
): RequestAuthorityResult {
  if (!req.url || !req.url.startsWith("/") || req.url.startsWith("//")) {
    return { ok: false, status: 400, message: "Request target must use origin form." };
  }

  const hostHeader = singleHeader(req.headers.host);
  const authorities = allowedAuthorities(env);
  if (!hostHeader || !authorities.some((allowed) => authorityMatches(hostHeader, allowed))) {
    return { ok: false, status: 421, message: "Request Host is not allowed for this cronogpt server." };
  }
  const forwardedHost = singleHeader(req.headers["x-forwarded-host"]);
  if (
    req.headers["x-forwarded-host"] !== undefined
    && (!forwardedHost || !authorities.some((allowed) => authorityMatches(forwardedHost, allowed)))
  ) {
    return { ok: false, status: 421, message: "Forwarded request Host is not allowed for this cronogpt server." };
  }
  const forwardedProto = singleHeader(req.headers["x-forwarded-proto"]);
  if (
    req.headers["x-forwarded-proto"] !== undefined
    && (!forwardedProto || !allowedProtocols(env).has(`${forwardedProto.toLowerCase()}:`))
  ) {
    return { ok: false, status: 421, message: "Forwarded request protocol is not allowed for this cronogpt server." };
  }

  const originHeader = singleHeader(req.headers.origin);
  if (req.headers.origin !== undefined && !originHeader) {
    return { ok: false, status: 403, message: "Request Origin is malformed." };
  }
  if (!originHeader) return { ok: true };

  const origin = parseBareHttpOrigin(originHeader);
  if (!origin || !allowedOrigins(env).has(origin)) {
    return { ok: false, status: 403, message: "Request Origin is not allowed for this cronogpt server." };
  }
  return { ok: true, origin };
}

export function applyCorsResponseHeaders(
  req: Pick<IncomingMessage, "headers">,
  res: Pick<ServerResponse, "getHeader" | "setHeader">,
  env: Environment = process.env,
) {
  const originHeader = singleHeader(req.headers.origin);
  const origin = originHeader ? parseBareHttpOrigin(originHeader) : undefined;
  if (!origin || !allowedOrigins(env).has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  const existingVary = res.getHeader("Vary");
  const values = new Set(
    (Array.isArray(existingVary) ? existingVary : String(existingVary ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("Origin");
  res.setHeader("Vary", Array.from(values).join(", "));
}

function allowedAuthorities(env: Environment) {
  const authorities: AllowedAuthority[] = [];
  const publicOrigin = parseBareHttpOrigin(env.APP_PUBLIC_ORIGIN?.trim());
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    authorities.push({ protocol: url.protocol as "http:" | "https:", host: url.host });
  }
  if (env.NODE_ENV?.trim() !== "production") {
    const port = requestPort(env.PORT);
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = new URL(`http://${hostname}:${port}`);
      authorities.push({ protocol: "http:", host: url.host });
    }
  }
  return authorities;
}

function allowedOrigins(env: Environment) {
  const origins = new Set<string>();
  const publicOrigin = parseBareHttpOrigin(env.APP_PUBLIC_ORIGIN?.trim());
  if (publicOrigin) origins.add(publicOrigin);
  for (const origin of parseConfiguredAllowedOrigins(env.CRONOGPT_ALLOWED_ORIGINS).origins) {
    origins.add(origin);
  }
  if (env.NODE_ENV?.trim() !== "production") {
    const port = requestPort(env.PORT);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://[::1]:${port}`);
  }
  return origins;
}

function allowedProtocols(env: Environment) {
  const protocols = new Set<string>();
  const publicOrigin = parseBareHttpOrigin(env.APP_PUBLIC_ORIGIN?.trim());
  if (publicOrigin) protocols.add(new URL(publicOrigin).protocol);
  if (env.NODE_ENV?.trim() !== "production") protocols.add("http:");
  return protocols;
}

function authorityMatches(value: string, allowed: AllowedAuthority) {
  if (/[\s,/@?#]/.test(value)) return false;
  try {
    const url = new URL(`${allowed.protocol}//${value}/`);
    return !url.username && !url.password && url.host === allowed.host;
  } catch {
    return false;
  }
}

function parseBareHttpOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const normalized = value.replace(/\/+$/, "");
    if (!/^https?:$/.test(url.protocol) || normalized !== url.origin) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function requestPort(value: string | undefined) {
  const normalized = value?.trim() || "8787";
  if (!/^\d+$/.test(normalized)) return 8787;
  const port = Number(normalized);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : 8787;
}

function singleHeader(value: string | string[] | undefined) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
