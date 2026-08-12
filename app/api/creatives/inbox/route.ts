import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import {
  BRIEFING_CACHE_MAX_ENTRIES,
  BRIEFING_CACHE_TTL_MS,
  briefingCache,
  type BriefingReadResult,
  type InboxCard,
} from "./route-state";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function csv(value: string | null) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numeric(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareNumericDescMissingLast(left: unknown, right: unknown) {
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return rightNumber - leftNumber;
}

function limitFromParam(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function todayIsoDateUtc() {
  return new Date().toISOString().slice(0, 10);
}

function internalBriefingOrigin() {
  const configuredPort = process.env.PORT?.trim() ?? "";
  const port = /^\d{1,5}$/.test(configuredPort) ? configuredPort : "3000";
  // This is a server-to-server composition call inside the same Next runtime.
  // Going back through the public hostname makes the inbox depend on external
  // ingress, DNS and bot filtering even though the dependency is local.
  return `http://127.0.0.1:${port}`;
}

function resolvedAsOfParam(request: NextRequest) {
  return request.nextUrl.searchParams.get("asOf")?.trim() || todayIsoDateUtc();
}

function authFingerprint(request: NextRequest) {
  const cookie = request.headers.get("cookie") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  return createHash("sha256")
    .update(`${cookie}\n${authorization}`)
    .digest("hex")
    .slice(0, 24);
}

function briefingCacheKey(input: { request: NextRequest; businessId: string }) {
  const params = input.request.nextUrl.searchParams;
  return [
    input.businessId,
    resolvedAsOfParam(input.request),
    params.get("status_filter") ?? "",
    authFingerprint(input.request),
  ].join("|");
}

function setBriefingCache(key: string, result: BriefingReadResult) {
  if (!result.ok) return;
  if (briefingCache.has(key)) briefingCache.delete(key);
  if (briefingCache.size >= BRIEFING_CACHE_MAX_ENTRIES) {
    const oldestKey = briefingCache.keys().next().value;
    if (oldestKey) briefingCache.delete(oldestKey);
  }
  briefingCache.set(key, {
    expiresAt: Date.now() + BRIEFING_CACHE_TTL_MS,
    result,
  });
}

async function readBusinessBriefing(input: {
  request: NextRequest;
  businessId: string;
}): Promise<BriefingReadResult> {
  const cacheKey = briefingCacheKey(input);
  const cached = briefingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    // Best-effort, per-process LRU cache. It reduces repeated read-only inbox
    // fanout but is not an authoritative decision source.
    briefingCache.delete(cacheKey);
    briefingCache.set(cacheKey, cached);
    return { ...cached.result, cacheHit: true };
  }
  if (cached) briefingCache.delete(cacheKey);

  const url = new URL("/api/creatives/briefing", internalBriefingOrigin());
  url.searchParams.set("businessId", input.businessId);
  url.searchParams.set("decisionCenter", "1");
  const asOf = resolvedAsOfParam(input.request);
  const statusFilter = input.request.nextUrl.searchParams.get("status_filter");
  url.searchParams.set("asOf", asOf);
  if (statusFilter) url.searchParams.set("status_filter", statusFilter);

  const headers = new Headers();
  const cookie = input.request.headers.get("cookie");
  const authorization = input.request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);

  const response = await fetch(url, {
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (!response) {
    return {
      businessId: input.businessId,
      ok: false as const,
      status: 503,
      error: "briefing_unavailable",
      cards: [] as InboxCard[],
      cacheHit: false,
    };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const result = {
      businessId: input.businessId,
      ok: false as const,
      status: response.status,
      error:
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : "briefing_unavailable",
      cards: [] as InboxCard[],
      cacheHit: false,
    };
    return result;
  }
  const actionNow = Array.isArray(payload?.actionNow) ? payload.actionNow : [];
  const watching = Array.isArray(payload?.watching) ? payload.watching : [];
  const healthy = Array.isArray(payload?.healthy) ? payload.healthy : [];
  const result = {
    businessId: input.businessId,
    ok: true as const,
    status: response.status,
    error: null,
    cards: [...actionNow, ...watching, ...healthy].map((card) => ({
      ...(card as BriefingCreativeCard),
      businessId: input.businessId,
    })),
    cacheHit: false,
  };
  setBriefingCache(cacheKey, result);
  return result;
}

export async function GET(request: NextRequest) {
  const businessIds = csv(request.nextUrl.searchParams.get("businessIds"));
  if (businessIds.length === 0) {
    return NextResponse.json(
      {
        error: "missing_business_ids",
        message: "businessIds must contain at least one business id.",
      },
      { status: 400 },
    );
  }

  const results = await Promise.all(
    businessIds.map((businessId) =>
      readBusinessBriefing({
        request,
        businessId,
      }),
    ),
  );
  const limit = limitFromParam(request.nextUrl.searchParams.get("limit"));
  const inbox = results
    .flatMap((result) => result.cards)
    .sort(
      (left, right) =>
        compareNumericDescMissingLast(
          left.priorityScore?.score,
          right.priorityScore?.score,
        ) ||
        compareNumericDescMissingLast(left.spend, right.spend) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, limit);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      businessesRequested: businessIds,
      businessesSucceeded: results.filter((result) => result.ok).length,
      errors: results
        .filter((result) => !result.ok)
        .map((result) => ({
          businessId: result.businessId,
          status: result.status,
          error: result.error,
        })),
      cache: {
        hits: results.filter((result) => result.cacheHit).length,
        misses: results.filter((result) => !result.cacheHit).length,
        entries: briefingCache.size,
        ttlMs: BRIEFING_CACHE_TTL_MS,
        maxEntries: BRIEFING_CACHE_MAX_ENTRIES,
      },
      inbox,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
