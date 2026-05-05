import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import {
  resolveEngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import type { EngineRiskPreset } from "@/lib/creative-decision-engine/types";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

function noStoreJson(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, {
    status: init?.status,
    headers: NO_STORE_HEADERS,
  });
}

function parseBusinessId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (UUID_PATTERN.test(trimmed) || POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function parsePreset(value: unknown): EngineRiskPreset | null | undefined {
  if (value === null) return null;
  if (
    value === "aggressive" ||
    value === "balanced" ||
    value === "conservative"
  ) {
    return value;
  }
  return undefined;
}

async function readBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const body = await readBody(request);
  const businessId = parseBusinessId(
    typeof body === "object" && body !== null
      ? (body as { businessId?: unknown }).businessId
      : undefined,
  );
  const preset = parsePreset(
    typeof body === "object" && body !== null
      ? (body as { preset?: unknown }).preset
      : undefined,
  );

  if (businessId === null) {
    return noStoreJson(
      { error: "invalid_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  if (preset === undefined) {
    return noStoreJson(
      {
        error: "invalid_preset",
        message:
          "preset must be aggressive, balanced, conservative, or null.",
      },
      { status: 400 },
    );
  }

  try {
    const auth = await requireAdmin(request);
    if (auth.error) {
      auth.error.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
      auth.error.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
      return auth.error;
    }

    await getDb().query(
      `
      INSERT INTO business_engine_v3_flags (
        business_id,
        preset_override,
        updated_by
      )
      VALUES ($1, $2, 'admin-engine-v3-preset')
      ON CONFLICT (business_id) DO UPDATE SET
        preset_override = EXCLUDED.preset_override,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      `,
      [businessId, preset],
    );

    const flags = await resolveEngineV3Flags(businessId);
    return noStoreJson(flags);
  } catch (error) {
    console.error("[admin/engine-v3/preset PATCH]", error);
    return noStoreJson(
      { error: "internal_error", message: String(error) },
      { status: 500 },
    );
  }
}
