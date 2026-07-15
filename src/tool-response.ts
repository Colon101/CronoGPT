import type { ProviderResult } from "./domain.js";

export function toMcpToolResponse(result: ProviderResult) {
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
    ? `${result.feature} is not complete. ${result.provider} accepted a background job; poll cronometer_runtime_status until it reaches a terminal status before retrying.`
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
      warning: result.warning,
      source: result.source,
      data: result.data,
    },
    content: [{ type: "text" as const, text }],
    isError: result.status === "error" && !softFailure,
  };
}
