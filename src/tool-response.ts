import type { ProviderResult } from "./domain.js";

export function toMcpToolResponse(result: ProviderResult) {
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  const softFailure = [
    "busy",
    "not_written_login_paused",
    "not_written_ambiguous",
    "not_written_not_found",
    "possibly_written_verify_failed",
    "needs_manual_step",
    "not_configured",
  ].includes(result.status);
  const completed = ["ok", "written", "already_exists"].includes(result.status);
  const intentSatisfied = completed;
  const ok = completed;
  const text = result.status === "accepted"
    ? `${result.feature} is in progress, not failed, and not complete yet. ${result.provider} scheduled operation ${String(data.operationId ?? "(see structured result)")}; do not resubmit it. Poll get_cronometer_operation until it reaches a terminal state.`
    : result.status === "dry_run"
      ? `${result.feature} returned a preview only from ${result.provider}; no requested write was completed.`
    : softFailure
      ? `${result.feature} did not complete on ${result.provider} (${result.status}): ${result.warning ?? "Follow the structured retry guidance."}`
      : ok
      ? `${result.feature} returned ${result.status} from ${result.provider}.`
      : `${result.feature} is ${result.status} on ${result.provider}: ${result.warning ?? "No details."}`;

  return {
    structuredContent: {
      ok,
      completed,
      intentSatisfied,
      provider: result.provider,
      mode: result.mode,
      feature: result.feature,
      status: result.status,
      state: data.state ?? (completed ? "succeeded" : result.status === "accepted" ? "running" : result.status === "possibly_written_verify_failed" ? "indeterminate" : "failed"),
      retryable: data.retryable ?? false,
      nextAction: data.nextAction ?? (result.status === "accepted" ? "poll" : result.status === "possibly_written_verify_failed" ? "inspect_diary" : "none"),
      operationId: data.operationId,
      warning: result.warning,
      source: result.source,
      data: result.data,
    },
    content: [{ type: "text" as const, text }],
    isError: result.status === "error" && !softFailure,
  };
}
