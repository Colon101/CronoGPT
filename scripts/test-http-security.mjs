#!/usr/bin/env node
import assert from "node:assert/strict";
import { request as sendHttpRequest } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const originalEnv = { ...process.env };
Object.assign(process.env, {
  NODE_ENV: "development",
  APP_PUBLIC_ORIGIN: "http://localhost:8787",
  PORT: "8787",
  CRONOMETER_BACKEND: "mock",
  CRONOMETER_ENABLE_WRITES: "false",
});
delete process.env.CRONOGPT_API_TOKEN;
delete process.env.CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH;
delete process.env.CRONOGPT_ALLOWED_ORIGINS;

const { authorizeMcpRequest } = await import("../dist/oauth.js");
const {
  MAX_CONCURRENT_MCP_REQUESTS,
  MAX_MCP_REQUEST_BODY_BYTES,
  __acquireMcpRequestSlotForTests,
  __resetMcpConcurrencyForTests,
  createCronoHttpServer,
} = await import("../dist/mcp.js");
const { validateRequestAuthority } = await import("../dist/http-security.js");

try {
  const localRequest = mockRequest({ host: "localhost:8787" }, "127.0.0.1");
  assert.equal(authorizeMcpRequest(localRequest).ok, false, "loopback must not implicitly authenticate");

  process.env.CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH = "true";
  assert.equal(authorizeMcpRequest(localRequest).ok, true, "the explicit mock-only dev opt-in remains available");
  assert.equal(
    authorizeMcpRequest(mockRequest({ host: "localhost:8787" }, "198.51.100.20")).ok,
    false,
    "the insecure development opt-in remains loopback-only",
  );
  process.env.CRONOMETER_BACKEND = "browser";
  assert.equal(authorizeMcpRequest(localRequest).ok, false, "the dev opt-in must fail closed for a real provider");
  process.env.CRONOMETER_BACKEND = "mock";
  process.env.CRONOMETER_ENABLE_WRITES = "true";
  assert.equal(authorizeMcpRequest(localRequest).ok, false, "the dev opt-in must fail closed when writes are enabled");
  process.env.CRONOMETER_ENABLE_WRITES = "false";

  delete process.env.CRONOGPT_INSECURE_DEV_ALLOW_NO_AUTH;
  process.env.CRONOGPT_API_TOKEN = "http-security-test-token";
  assert.equal(authorizeMcpRequest(localRequest).ok, false, "configured authentication must require a bearer credential");
  const bearerRequest = mockRequest({
    host: "localhost:8787",
    authorization: "Bearer http-security-test-token",
  }, "127.0.0.1");
  assert.equal(authorizeMcpRequest(bearerRequest).ok, true);

  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    origin: "http://localhost:8787",
  })).ok, true);
  assert.equal(validateRequestAuthority(mockRequest({ host: "127.0.0.1:8787" })).ok, true);
  assert.equal(validateRequestAuthority(mockRequest({ host: "rebind.attacker.example:8787" })).status, 421);
  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    origin: "https://attacker.example",
  })).status, 403);
  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    "x-forwarded-host": "rebind.attacker.example:8787",
  })).status, 421);
  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    "x-forwarded-proto": "https",
  })).status, 421);
  process.env.CRONOGPT_ALLOWED_ORIGINS = "http://localhost:6274";
  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    origin: "http://localhost:6274",
  })).ok, true);
  assert.equal(validateRequestAuthority(mockRequest({
    host: "localhost:8787",
    origin: "http://localhost:6274.attacker.example",
  })).ok, false);
  const productionAuthorityEnv = {
    NODE_ENV: "production",
    APP_PUBLIC_ORIGIN: "https://cronogpt.example",
    PORT: "8787",
    CRONOGPT_ALLOWED_ORIGINS: "https://chatgpt.com",
  };
  assert.equal(validateRequestAuthority(
    mockRequest({
      host: "cronogpt.example",
      origin: "https://chatgpt.com",
      "x-forwarded-host": "cronogpt.example",
      "x-forwarded-proto": "https",
    }),
    productionAuthorityEnv,
  ).ok, true, "the configured production Host and exact ChatGPT Origin remain allowed");
  assert.equal(validateRequestAuthority(
    mockRequest({ host: "127.0.0.1:8787" }),
    productionAuthorityEnv,
  ).status, 421, "production does not accept a loopback Host alias");

  __resetMcpConcurrencyForTests();
  const releases = Array.from({ length: MAX_CONCURRENT_MCP_REQUESTS }, () => __acquireMcpRequestSlotForTests());
  assert.ok(releases.every(Boolean));
  assert.equal(__acquireMcpRequestSlotForTests(), undefined, "MCP concurrency must have a hard admission cap");
  releases.forEach((release) => release());
  const finalRelease = __acquireMcpRequestSlotForTests();
  assert.ok(finalRelease);
  finalRelease();
  __resetMcpConcurrencyForTests();

  delete process.env.CRONOGPT_ALLOWED_ORIGINS;
  const server = createCronoHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.PORT = String(address.port);
    process.env.APP_PUBLIC_ORIGIN = `http://localhost:${address.port}`;
    const allowedHeaders = {
      authorization: "Bearer http-security-test-token",
      host: `localhost:${address.port}`,
      origin: `http://localhost:${address.port}`,
    };

    const authenticatedClient = new Client({ name: "cronogpt-http-security-test", version: "1.0.0" });
    const authenticatedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer http-security-test-token" } } },
    );
    await authenticatedClient.connect(authenticatedTransport);
    assert.ok((await authenticatedClient.listTools()).tools.length > 0);
    await authenticatedClient.close();

    const badHost = await httpRequest(address.port, "OPTIONS", "", {
      ...allowedHeaders,
      host: `rebind.attacker.example:${address.port}`,
    });
    assert.equal(badHost.status, 421);

    const absoluteTarget = await httpRequest(address.port, "OPTIONS", "", allowedHeaders, "http://attacker.example/mcp");
    assert.equal(absoluteTarget.status, 400);

    const badOrigin = await httpRequest(address.port, "OPTIONS", "", {
      ...allowedHeaders,
      origin: "https://attacker.example",
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.headers["access-control-allow-origin"], undefined);

    const preflight = await httpRequest(address.port, "OPTIONS", "", allowedHeaders);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], `http://localhost:${address.port}`);
    assert.notEqual(preflight.headers["access-control-allow-origin"], "*");

    const oversized = "x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1);
    const tooLarge = await httpRequest(address.port, "POST", oversized, {
      ...allowedHeaders,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(oversized)),
    });
    assert.equal(tooLarge.status, 413);

    const tooLargeChunked = await httpRequest(address.port, "POST", oversized, {
      ...allowedHeaders,
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    });
    assert.equal(tooLargeChunked.status, 413);

    const heldSlots = Array.from(
      { length: MAX_CONCURRENT_MCP_REQUESTS },
      () => __acquireMcpRequestSlotForTests(),
    );
    const busy = await httpRequest(address.port, "POST", "{}", {
      ...allowedHeaders,
      "content-type": "application/json",
    });
    assert.equal(busy.status, 503);
    heldSlots.forEach((release) => release());

    const unauthenticated = await httpRequest(address.port, "POST", "{}", {
      host: `localhost:${address.port}`,
      origin: `http://localhost:${address.port}`,
      "content-type": "application/json",
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("HTTP security checks passed");
} finally {
  __resetMcpConcurrencyForTests();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function mockRequest(headers = {}, remoteAddress = "198.51.100.20") {
  const req = Readable.from([]);
  req.method = "POST";
  req.url = "/mcp";
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

function httpRequest(port, method, body, headers, path = "/mcp") {
  return new Promise((resolve, reject) => {
    const req = sendHttpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
