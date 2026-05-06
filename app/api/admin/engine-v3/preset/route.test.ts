import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => dbMocks),
}));

const adminAuth = await import("@/lib/admin-auth");
const { PATCH } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

const previousEnv = {
  DECISION_ENGINE_V3_ENABLED: process.env.DECISION_ENGINE_V3_ENABLED,
  DECISION_ENGINE_V3_SURFACE_VISIBLE:
    process.env.DECISION_ENGINE_V3_SURFACE_VISIBLE,
  DECISION_ENGINE_V3_SHADOW_ONLY: process.env.DECISION_ENGINE_V3_SHADOW_ONLY,
};

let flagRow: {
  enabled: boolean | null;
  surface_visible: boolean | null;
  shadow_only: boolean | null;
  preset_override: string | null;
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function handleQuery(queryText: string, values?: unknown[]) {
  const normalized = queryText.replace(/\s+/g, " ").trim();

  if (normalized.startsWith("INSERT INTO business_engine_v3_flags")) {
    flagRow = {
      ...flagRow,
      preset_override: values?.[1] === null ? null : String(values?.[1]),
    };
    return [];
  }

  if (normalized.includes("FROM business_engine_v3_flags")) {
    return [flagRow];
  }

  throw new Error(`Unhandled preset route test query: ${normalized}`);
}

function mockAdmin() {
  vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
    session: { user: { id: "admin-1", email: "admin@example.test" } },
  } as never);
}

function mockAuthError(status: 401 | 403) {
  vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
    error: NextResponse.json(
      {
        error: status === 401 ? "auth_error" : "forbidden",
        message:
          status === 401
            ? "Authentication required."
            : "Admin access required.",
      },
      { status },
    ),
  } as never);
}

function presetRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/engine-v3/preset", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/admin/engine-v3/preset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
    process.env.DECISION_ENGINE_V3_ENABLED = "true";
    process.env.DECISION_ENGINE_V3_SURFACE_VISIBLE = "true";
    process.env.DECISION_ENGINE_V3_SHADOW_ONLY = "false";
    flagRow = {
      enabled: null,
      surface_visible: null,
      shadow_only: null,
      preset_override: null,
    };
    mockAdmin();
    dbMocks.query.mockImplementation(handleQuery);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("returns 401 when no auth session exists", async () => {
    mockAuthError(401);

    const response = await PATCH(
      presetRequest({ businessId: BUSINESS_ID, preset: "conservative" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toBe("auth_error");
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not an admin", async () => {
    mockAuthError(403);

    const response = await PATCH(
      presetRequest({ businessId: BUSINESS_ID, preset: "conservative" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it("returns 400 when businessId is missing or invalid", async () => {
    const missing = await PATCH(presetRequest({ preset: "balanced" }));
    const invalid = await PATCH(
      presetRequest({ businessId: "not-a-number", preset: "balanced" }),
    );

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(
      expect.objectContaining({ error: "invalid_business_id" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(
      expect.objectContaining({ error: "invalid_business_id" }),
    );
    expect(adminAuth.requireAdmin).not.toHaveBeenCalled();
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it("returns 400 when preset is not a supported value or null", async () => {
    const response = await PATCH(
      presetRequest({ businessId: BUSINESS_ID, preset: "maximum" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("invalid_preset");
    expect(adminAuth.requireAdmin).not.toHaveBeenCalled();
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it('updates preset_override and returns flags for preset="conservative"', async () => {
    const response = await PATCH(
      presetRequest({ businessId: BUSINESS_ID, preset: "conservative" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(flagRow.preset_override).toBe("conservative");
    expect(dbMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO business_engine_v3_flags"),
      [BUSINESS_ID, "conservative"],
    );
    expect(payload).toMatchObject({
      businessId: BUSINESS_ID,
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
      presetOverride: "conservative",
      source: {
        enabled: "env",
        surfaceVisible: "env",
        shadowOnly: "env",
        presetOverride: "business_override",
      },
    });
  });

  it("clears preset_override when preset is null", async () => {
    flagRow.preset_override = "aggressive";

    const response = await PATCH(
      presetRequest({ businessId: BUSINESS_ID, preset: null }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(flagRow.preset_override).toBeNull();
    expect(dbMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO business_engine_v3_flags"),
      [BUSINESS_ID, null],
    );
    expect(payload).toMatchObject({
      presetOverride: null,
      source: {
        presetOverride: null,
      },
    });
  });
});
