import type { ProviderResult } from "./domain.js";

export function toMcpToolResponse(result: ProviderResult) {
  const ok = result.status === "ok" || result.status === "dry_run";
  const text = ok
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
    isError: result.status === "error",
  };
}
