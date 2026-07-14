import type { DateRangeInput } from "../domain.js";
import { compareStringsOrdinal, isoDateInTimeZone, systemClock, type Clock } from "../determinism.js";
import { BaseCronometerProvider } from "./base.js";

export interface TerraConfig {
  apiBaseUrl: string;
  apiKey: string;
  devId: string;
  userId: string;
  timeZone?: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export class TerraCronometerProvider extends BaseCronometerProvider {
  constructor(private readonly config: TerraConfig) {
    super("terra", "terra");
  }

  async getDailySummary(input: DateRangeInput) {
    return this.getNutrition("get_daily_summary", input);
  }

  async listFoodEntries(input: DateRangeInput) {
    return this.getNutrition("list_food_entries", input);
  }

  async listBiometrics(input: DateRangeInput) {
    return this.requestFeature("list_biometrics", "/body", input);
  }

  async listExercises(input: DateRangeInput) {
    return this.requestFeature("list_exercises", "/activity", input);
  }

  private async getNutrition(feature: string, input: DateRangeInput) {
    return this.requestFeature(feature, "/nutrition", input);
  }

  private async requestFeature(feature: string, path: string, input: DateRangeInput) {
    try {
      const today = isoDateInTimeZone(this.config.timeZone ?? "UTC", (this.config.clock ?? systemClock)());
      const data = await this.request(path, {
        user_id: this.config.userId,
        start_date: input.startDate ?? input.date ?? today,
        end_date: input.endDate ?? input.date ?? today,
        to_webhook: "false",
      });
      return this.result(feature, "ok", data, undefined, "terra");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Terra API error";
      return this.result(feature, "error", undefined, message, "terra");
    }
  }

  private async request(path: string, query: Record<string, string>) {
    const base = this.config.apiBaseUrl.replace(/\/$/, "");
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query).sort(([left], [right]) => compareStringsOrdinal(left, right))) {
      url.searchParams.set(key, value);
    }

    const response = await (this.config.fetchImpl ?? fetch)(url, {
      headers: {
        Accept: "application/json",
        "dev-id": this.config.devId,
        "x-api-key": this.config.apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Terra API returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    return response.json();
  }
}
