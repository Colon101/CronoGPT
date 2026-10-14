import type { ProviderResult, ProviderStatus } from "./domain.js";

/**
 * Public operation states shared by the response normalizer and the MCP output
 * schema. Keep this tuple as the single source of truth so provider metadata
 * cannot make an otherwise successful tool call fail output validation.
 */
export const MCP_OPERATION_STATE_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
] as const;

export type McpOperationState = (typeof MCP_OPERATION_STATE_VALUES)[number];

/**
 * Every action currently emitted by a provider belongs here. Unknown runtime
 * values are intentionally replaced with the status default instead of being
 * forwarded into the MCP contract.
 */
export const MCP_NEXT_ACTION_VALUES = [
  "none",
  "poll",
  "poll_operation",
  "inspect_diary",
  "retry_with_same_key",
  "manual_resolution",
  "repair_operation_journal",
  "use_new_idempotency_key",
] as const;

export type McpNextAction = (typeof MCP_NEXT_ACTION_VALUES)[number];

interface StatusContract {
  state: McpOperationState;
  retryable: boolean;
  nextAction: McpNextAction;
}

const STATUS_CONTRACT: Record<ProviderStatus, StatusContract> = {
  ok: { state: "succeeded", retryable: false, nextAction: "none" },
  written: { state: "succeeded", retryable: false, nextAction: "none" },
  already_exists: { state: "succeeded", retryable: false, nextAction: "none" },
  // A preview ran successfully, but completed/intentSatisfied remain false
  // because the requested mutation was deliberately not performed.
  dry_run: { state: "succeeded", retryable: false, nextAction: "none" },
  accepted: { state: "running", retryable: false, nextAction: "poll" },
  busy: { state: "pending", retryable: true, nextAction: "retry_with_same_key" },
  not_written_login_paused: { state: "pending", retryable: true, nextAction: "retry_with_same_key" },
  not_written_ambiguous: { state: "failed", retryable: false, nextAction: "manual_resolution" },
  not_written_not_found: { state: "failed", retryable: false, nextAction: "manual_resolution" },
  possibly_written_verify_failed: { state: "indeterminate", retryable: false, nextAction: "inspect_diary" },
  not_configured: { state: "failed", retryable: false, nextAction: "manual_resolution" },
  unsupported: { state: "failed", retryable: false, nextAction: "manual_resolution" },
  needs_manual_step: { state: "failed", retryable: false, nextAction: "manual_resolution" },
  error: { state: "failed", retryable: false, nextAction: "manual_resolution" },
};

const VALID_STATES = new Set<string>(MCP_OPERATION_STATE_VALUES);
const VALID_NEXT_ACTIONS = new Set<string>(MCP_NEXT_ACTION_VALUES);
const TERMINAL_SUCCESS_STATUSES = new Set<ProviderStatus>(["ok", "written", "already_exists"]);

function isOperationState(value: unknown): value is McpOperationState {
  return typeof value === "string" && VALID_STATES.has(value);
}

function isNextAction(value: unknown): value is McpNextAction {
  return typeof value === "string" && VALID_NEXT_ACTIONS.has(value);
}

function normalizedState(status: ProviderStatus, candidate: unknown): McpOperationState {
  // These statuses carry safety-critical semantics and must not be weakened by
  // stale or contradictory provider metadata.
  if (TERMINAL_SUCCESS_STATUSES.has(status) || status === "dry_run" || status === "accepted" || status === "possibly_written_verify_failed") {
    return STATUS_CONTRACT[status].state;
  }
  return isOperationState(candidate) ? candidate : STATUS_CONTRACT[status].state;
}

function normalizedRetryable(status: ProviderStatus, candidate: unknown): boolean {
  if (TERMINAL_SUCCESS_STATUSES.has(status) || status === "dry_run" || status === "accepted" || status === "possibly_written_verify_failed") {
    return STATUS_CONTRACT[status].retryable;
  }
  return typeof candidate === "boolean" ? candidate : STATUS_CONTRACT[status].retryable;
}

function normalizedNextAction(status: ProviderStatus, candidate: unknown): McpNextAction {
  if (TERMINAL_SUCCESS_STATUSES.has(status) || status === "dry_run" || status === "accepted") {
    return STATUS_CONTRACT[status].nextAction;
  }
  return isNextAction(candidate) ? candidate : STATUS_CONTRACT[status].nextAction;
}

export function toMcpToolResponse(result: ProviderResult) {
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
  const completed = TERMINAL_SUCCESS_STATUSES.has(result.status);
  const intentSatisfied = completed;
  const ok = completed;
  const state = normalizedState(result.status, data.state);
  const retryable = normalizedRetryable(result.status, data.retryable);
  const nextAction = normalizedNextAction(result.status, data.nextAction);
  const publicWarning = sanitizePublicString(result.warning);
  const publicData = sanitizePublicValue(result.data);
  const operationId = typeof data.operationId === "string" && data.operationId.trim()
    ? data.operationId
    : undefined;
  const softFailure = [
    "busy",
    "not_written_login_paused",
    "not_written_ambiguous",
    "not_written_not_found",
    "possibly_written_verify_failed",
    "needs_manual_step",
    "not_configured",
  ].includes(result.status);
  const text = result.status === "accepted"
    ? `${result.feature} is in progress, not failed, and not complete yet. ${result.provider} scheduled operation ${operationId ?? "(see structured result)"}; do not resubmit it. Poll get_cronometer_operation until it reaches a terminal state.`
    : result.status === "dry_run"
      ? `${result.feature} completed a preview on ${result.provider}; no requested write was performed.`
    : softFailure
      ? `${result.feature} did not complete on ${result.provider} (${result.status}): ${publicWarning ?? "Follow the structured retry guidance."}`
      : ok
      ? `${result.feature} returned ${result.status} from ${result.provider}.`
      : `${result.feature} is ${result.status} on ${result.provider}: ${publicWarning ?? "No details."}`;

  return {
    structuredContent: {
      ok,
      completed,
      intentSatisfied,
      provider: result.provider,
      mode: result.mode,
      feature: result.feature,
      status: result.status,
      state,
      retryable,
      nextAction,
      operationId,
      warning: publicWarning,
      source: result.source,
      data: publicData,
    },
    content: [{ type: "text" as const, text }],
    isError: result.status === "error",
  };
}

function sanitizePublicString(value: string | undefined) {
  if (value === undefined) return undefined;
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|api[_-]?key|authorization|key|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function sanitizePublicValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizePublicString(value);
  if (value === null || typeof value !== "object" || depth >= 12) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, sanitizePublicValue(item, depth + 1)]),
  );
}
