import type { AiDailyInsightSnapshot } from "@/src/types";
import {
  buildApiUrl,
  getApiErrorMessage,
  readJsonResponse,
} from "@/src/services/data-service-support";

export async function getLatestAiInsight(
  businessId: string,
): Promise<AiDailyInsightSnapshot | null> {
  const url = buildApiUrl("/api/ai/insights/latest");
  url.searchParams.set("businessId", businessId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `AI insight request failed with status ${response.status}`),
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("AI insight API returned an invalid payload.");
  }

  const insight = "insight" in payload ? (payload as { insight: unknown }).insight : null;
  if (!insight) return null;

  return insight as AiDailyInsightSnapshot;
}

export async function generateAiInsight(businessId: string): Promise<void> {
  const url = buildApiUrl("/api/ai/insights/generate");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ businessId }),
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `AI insight generation failed with status ${response.status}`),
    );
  }
}
