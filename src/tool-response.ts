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
  const ok = ["ok", "dry_run", "accepted", "written", "already_exists"].includes(result.status) || softFailure;
  const text = result.status === "accepted"
    ? `${result.feature} accepted a background job on ${result.provider}. Poll cronometer_runtime_status until it completes before retrying.`
    : ok
      ? `${result.feature} returned ${result.status} from ${result.provider}.`
      : `${result.feature} is ${result.status} on ${result.provider}: ${result.warning ?? "No details."}`;

  return {
    structuredContent: {
      ok,
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
