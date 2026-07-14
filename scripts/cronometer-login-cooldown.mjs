#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultFile = ".cronometer-login-backoff.json";

if (isMainModule()) {
  await import("dotenv/config");
  try {
    console.log(JSON.stringify(runCooldownCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    if (error instanceof CooldownUsageError) usage(error.exitCode);
    throw error;
  }
}

export function runCooldownCommand(
  args,
  { env = process.env, now = Date.now() } = {},
) {
  const filePath = env.CRONOMETER_LOGIN_BACKOFF_FILE?.trim() || defaultFile;
  const command = args[0] ?? "status";

  if (command === "status") return cooldownStatus(filePath, now);
  if (command === "clear") {
    if (existsSync(filePath)) unlinkSync(filePath);
    return { filePath, active: false, cleared: true };
  }
  if (command === "set") {
    const commandArgs = args.slice(1);
    const seconds = commandArgs[0] === undefined
      ? defaultCooldownSeconds(env)
      : parsePositiveSeconds(commandArgs[0]);
    const reason = commandArgs.slice(1).join(" ").trim() || "Manual Cronometer login cooldown.";
    const state = { until: now + seconds * 1000, reason, updatedAt: now };
    writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(filePath, 0o600);
    return cooldownStatus(filePath, now);
  }

  throw new CooldownUsageError(1);
}

function cooldownStatus(filePath, now) {
  const state = readCooldown(filePath);
  if (!state) return { filePath, active: false };

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
  return output;
}

function readCooldown(filePath) {
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

function defaultCooldownSeconds(env) {
  const value = env.CRONOMETER_LOGIN_BACKOFF_MS?.trim() || "900000";
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) throw new CooldownUsageError(1);
  return Math.ceil(ms / 1000);
}

function parsePositiveSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new CooldownUsageError(1);
  return Math.ceil(number);
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

class CooldownUsageError extends Error {
  constructor(exitCode) {
    super("Invalid cooldown command or duration.");
    this.exitCode = exitCode;
  }
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
