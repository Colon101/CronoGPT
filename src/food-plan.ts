import type { CronometerProvider, FoodLogInput, FoodLogPlanInput, ProviderResult, ProviderStatus } from "./domain.js";

export interface FoodPlanRunOptions {
  settleAcceptedOperations?: boolean;
  onProgress?: (progress: Record<string, unknown>) => void;
}

type MultiDayFoodPlanItem = FoodLogInput & { date: string; meal: string };

export async function runFoodLogPlan(provider: CronometerProvider, args: FoodLogPlanInput, options: FoodPlanRunOptions = {}): Promise<ProviderResult> {
  const items = (args.items ?? []) as MultiDayFoodPlanItem[];
  const planIdempotencyKey = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
    ? args.idempotencyKey.trim()
    : deterministicPlanKey("food", items);
  const groups = groupFoodPlanItems(items);
  const groupResults: Array<Record<string, unknown>> = [];
  let attemptedCount = 0;
  let stoppedEarly = false;
  const publishProgress = (activeGroupIndex?: number, activeOperationId?: string) => {
    options.onProgress?.({
      groupCount: groups.length,
      completedGroupCount: groupResults.filter((group) => successfulFoodPlanStatus(group.status as ProviderStatus)).length,
      activeGroupIndex,
      activeOperationId,
      groups: [...groupResults],
    });
  };

  for (const [groupIndex, group] of groups.entries()) {
    let result = await provider.logFoods({
      date: group.date,
      meal: group.meal,
      items: group.items.map(({ date: _date, meal: _meal, ...item }, itemIndex) => ({
        ...item,
        idempotencyKey: item.idempotencyKey ?? `${planIdempotencyKey}:item:${group.itemIndices[itemIndex]}`,
      })),
      dryRun: args.dryRun,
      confirmed: args.confirmed,
      idempotencyKey: `${planIdempotencyKey}:group:${groupIndex}`,
      stopOnFirstFailure: args.stopOnFirstFailure,
      waitForCompletionSeconds: options.settleAcceptedOperations ? 0 : args.waitForCompletionSeconds,
    });
    if (options.settleAcceptedOperations && result.status === "accepted") {
      const operationId = resultData(result).operationId;
      publishProgress(groupIndex, typeof operationId === "string" ? operationId : undefined);
      if (typeof operationId !== "string" || !operationId) {
        result = { ...result, status: "possibly_written_verify_failed", warning: "The meal was accepted without an operation ID. No later meal was started." };
      } else {
        while (result.status === "accepted") {
          // Poll only memory/journal state. This does not open a second browser
          // or submit another write, and the parent stays alive across MCP calls.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          result = await provider.getOperation(operationId);
        }
        if (["not_configured", "unsupported"].includes(result.status)) {
          result = { ...result, status: "possibly_written_verify_failed", warning: "The accepted meal operation could no longer be located. Inspect that meal before retrying; no later meal was started.", data: { ...resultData(result), operationId, nextAction: "inspect_diary" } };
        }
      }
    }
    const data = resultData(result);
    const attemptedInGroup = typeof data.attemptedCount === "number"
      ? Math.min(group.items.length, Math.max(0, Math.trunc(data.attemptedCount)))
      : group.items.length;
    attemptedCount += attemptedInGroup;
    groupResults.push({
      groupIndex,
      date: group.date,
      meal: group.meal,
      itemIndices: group.itemIndices,
      status: result.status,
      warning: result.warning,
      operationId: data.operationId,
      data,
      attemptedItemCount: attemptedInGroup,
    });

    publishProgress();

    if (mustStopOrchestratedPlan(result.status)
      || (args.stopOnFirstFailure !== false && !successfulFoodPlanStatus(result.status) && result.status !== "dry_run")) {
      stoppedEarly = groupIndex < groups.length - 1;
      break;
    }
  }

  const statuses = groupResults.map((result) => result.status as ProviderStatus);
  const status = aggregateOrchestratedStatus(statuses, groups.length, successfulFoodPlanStatus);
  const acceptedOperationId = status === "accepted"
    ? [...groupResults].reverse().find((result) => result.status === "accepted")?.operationId
    : undefined;
  const previewCompleted = groupResults.length === groups.length && statuses.every((candidate) => candidate === "dry_run");
  const completed = groupResults.length === groups.length && statuses.every(successfulFoodPlanStatus);
  const currentPartialGroup = groupResults.length > 0
    ? groups[groupResults.length - 1]
    : undefined;
  const currentPartialAttempted = groupResults.length > 0
    ? Number(groupResults[groupResults.length - 1]?.attemptedItemCount ?? currentPartialGroup?.items.length ?? 0)
    : 0;
  const remainingItemIndices = [
    ...(currentPartialGroup ? currentPartialGroup.itemIndices.slice(currentPartialAttempted) : []),
    ...groups.slice(groupResults.length).flatMap((group) => group.itemIndices),
  ];
  return {
    provider: provider.name,
    mode: provider.mode,
    feature: "log_food_plan",
    status,
    source: "mcp-multi-day-orchestrator",
    warning: completed || previewCompleted
      ? undefined
      : "The multi-day food plan did not fully complete. Inspect group statuses and continue only with untouched or definitively unwritten items; never blindly replay an ambiguous group.",
    data: {
      planIdempotencyKey,
      count: items.length,
      attemptedCount,
      groupCount: groups.length,
      attemptedGroupCount: groupResults.length,
      completed,
      previewCompleted,
      stoppedEarly,
      operationId: acceptedOperationId,
      groups: groupResults,
      remainingItemIndices,
    },
  };
}

export function groupFoodPlanItems(items: MultiDayFoodPlanItem[]) {
  const groups = new Map<string, { date: string; meal: string; items: MultiDayFoodPlanItem[]; itemIndices: number[] }>();
  items.forEach((item, index) => {
    const key = JSON.stringify([item.date, item.meal]);
    const group = groups.get(key) ?? { date: item.date, meal: item.meal, items: [], itemIndices: [] };
    group.items.push(item);
    group.itemIndices.push(index);
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

export function deterministicPlanKey(kind: string, value: unknown) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}-plan-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function resultData(result: ProviderResult) {
  return result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
}

export function successfulFoodPlanStatus(status: ProviderStatus) {
  return status === "written" || status === "already_exists";
}

export function mustStopOrchestratedPlan(status: ProviderStatus) {
  return status === "accepted"
    || status === "possibly_written_verify_failed"
    || status === "busy"
    || status === "error";
}

export function aggregateOrchestratedStatus(
  statuses: ProviderStatus[],
  expectedCount: number,
  succeeded: (status: ProviderStatus) => boolean,
): ProviderStatus {
  if (statuses.length === expectedCount && statuses.every(succeeded)) {
    return statuses.every((status) => status === "ok") ? "ok" : "written";
  }
  if (statuses.length === expectedCount && statuses.every((status) => status === "dry_run")) return "dry_run";
  for (const candidate of [
    "accepted",
    "possibly_written_verify_failed",
    "error",
    "busy",
    "not_written_login_paused",
    "not_written_ambiguous",
    "not_written_not_found",
    "needs_manual_step",
    "not_configured",
    "unsupported",
  ] as const) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "needs_manual_step";
}

