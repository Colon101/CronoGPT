#!/usr/bin/env node
import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const defaultFile = ".cronometer-login-backoff.json";
const filePath = process.env.CRONOMETER_LOGIN_BACKOFF_FILE?.trim() || defaultFile;
const command = process.argv[2] ?? "status";

if (command === "status") {
  printStatus();
} else if (command === "clear") {
  clearCooldown();
} else if (command === "set") {
  setCooldown(process.argv.slice(3));
} else {
  usage(1);
}

function printStatus() {
  const state = readCooldown();
  if (!state) {
    console.log(JSON.stringify({ filePath, active: false }, null, 2));
    return;
  }

  const now = Date.now();
  const active = state.until > now;
  const output = {
    filePath,
    active,
    until: state.until,
    secondsRemaining: active ? Math.ceil((state.until - now) / 1000) : 0,
    reason: state.reason,
    updatedAt: state.updatedAt,
  };
  if (state.until > 0) output.untilIso = new Date(state.until).toISOString();
  if (state.updatedAt) output.updatedAtIso = new Date(state.updatedAt).toISOString();
  if (state.malformed) output.malformed = true;
  console.log(JSON.stringify(output, null, 2));
}

function setCooldown(args) {
  const seconds = args[0] === undefined ? defaultCooldownSeconds() : parsePositiveSeconds(args[0]);
  const reason = args.slice(1).join(" ").trim() || "Manual Cronometer login cooldown.";
  const until = Date.now() + seconds * 1000;
  writeFileSync(filePath, JSON.stringify({ until, reason, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  printStatus();
}

function clearCooldown() {
  if (existsSync(filePath)) unlinkSync(filePath);
  console.log(JSON.stringify({ filePath, active: false, cleared: true }, null, 2));
}

function readCooldown() {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return {
      until: typeof parsed.until === "number" ? parsed.until : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      until: 0,
      reason: `Unreadable cooldown file: ${message}`,
      malformed: true,
    };
  }
}

function defaultCooldownSeconds() {
  const value = process.env.CRONOMETER_LOGIN_BACKOFF_MS?.trim() || "900000";
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) usage(1);
  return Math.ceil(ms / 1000);
}

function parsePositiveSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) usage(1);
  return Math.ceil(number);
}

function usage(exitCode) {
  console.error([
    "Usage:",
    "  npm run cronometer:cooldown -- status",
    "  npm run cronometer:cooldown -- set 900 \"Too Many Attempts\"",
    "  npm run cronometer:cooldown -- clear",
    "",
    "Without an explicit set duration, CRONOMETER_LOGIN_BACKOFF_MS is read as milliseconds.",
  ].join("\n"));
  process.exit(exitCode);
}
