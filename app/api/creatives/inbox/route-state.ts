import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

export const BRIEFING_CACHE_TTL_MS = 60_000;
export const BRIEFING_CACHE_MAX_ENTRIES = 200;

export type InboxCard = BriefingCreativeCard & {
  businessId: string;
};

export type BriefingReadResult = {
  businessId: string;
  ok: boolean;
  status: number;
  error: string | null;
  cards: InboxCard[];
  cacheHit: boolean;
};

export const briefingCache = new Map<
  string,
  { expiresAt: number; result: BriefingReadResult }
>();

export function clearCreativeInboxBriefingCacheForTests() {
  briefingCache.clear();
}
