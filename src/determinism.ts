/** A clock boundary that callers can replace in tests. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * Compares strings by their JavaScript code-unit order. Unlike localeCompare,
 * this is independent of the host locale and ICU version.
 */
export function compareStringsOrdinal(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** JSON serialization with recursively sorted object keys. */
export function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareStringsOrdinal(left, right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function isoDateInTimeZone(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
