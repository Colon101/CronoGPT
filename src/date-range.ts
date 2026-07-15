import type { DateRangeInput } from "./domain.js";
import { isoDateInTimeZone } from "./determinism.js";
import { isValidFoodLogDate } from "./food-log-transaction.js";

export interface NormalizedDateRange {
  startDate: string;
  endDate: string;
  dates: string[];
  issues: string[];
}

export function normalizeDateRange(
  input: DateRangeInput,
  timeZone: string,
  now = new Date(),
  maxDays = 31,
): NormalizedDateRange {
  const today = isoDateInTimeZone(timeZone, now);
  const issues: string[] = [];
  if (input.date && (input.startDate || input.endDate)) {
    issues.push("Use either date or startDate/endDate, not both.");
  }
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    issues.push("Provide both startDate and endDate for a range, or use date for one day.");
  }

  const single = normalizeDateValue(input.date, today);
  const start = single ?? normalizeDateValue(input.startDate, today) ?? normalizeDateValue(input.endDate, today) ?? today;
  const end = single ?? normalizeDateValue(input.endDate, today) ?? normalizeDateValue(input.startDate, today) ?? today;
  for (const [label, raw, normalized] of [
    ["date", input.date, single],
    ["startDate", input.startDate, input.startDate ? normalizeDateValue(input.startDate, today) : undefined],
    ["endDate", input.endDate, input.endDate ? normalizeDateValue(input.endDate, today) : undefined],
  ] as const) {
    if (raw !== undefined && !normalized) issues.push(`${label} is invalid: ${JSON.stringify(raw)}.`);
  }

  if (!isValidFoodLogDate(start) || !isValidFoodLogDate(end)) {
    return { startDate: start, endDate: end, dates: [], issues: [...new Set(issues)] };
  }
  const dayCount = daysBetweenIso(start, end) + 1;
  if (dayCount <= 0) issues.push("startDate must be on or before endDate.");
  if (dayCount > maxDays) issues.push(`Date range contains ${dayCount} days; the maximum for this operation is ${maxDays}.`);
  if (issues.length > 0) return { startDate: start, endDate: end, dates: [], issues: [...new Set(issues)] };

  return {
    startDate: start,
    endDate: end,
    dates: Array.from({ length: dayCount }, (_, index) => addDaysIso(start, index)),
    issues: [],
  };
}

export function normalizeDateValue(value: string | undefined, today: string) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "today") return today;
  if (normalized.toLowerCase() === "yesterday") return addDaysIso(today, -1);
  if (normalized.toLowerCase() === "tomorrow") return addDaysIso(today, 1);
  return isValidFoodLogDate(normalized) ? normalized : undefined;
}

function addDaysIso(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetweenIso(from: string, to: string) {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
}
