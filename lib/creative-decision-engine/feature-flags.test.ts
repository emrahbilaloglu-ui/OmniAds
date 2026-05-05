import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { getDb, resetDbClientCache } from "@/lib/db";
import { runMigrations } from "@/lib/migrations";
import {
  listEnabledBusinessIds,
  readEnvDefaults,
  resolveEngineV3Flags,
} from "./feature-flags";

const FLAG_ENV_KEYS = [
  "DECISION_ENGINE_V3_ENABLED",
  "DECISION_ENGINE_V3_SURFACE_VISIBLE",
  "DECISION_ENGINE_V3_SHADOW_ONLY",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  FLAG_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof FLAG_ENV_KEYS)[number], string | undefined>;

const FIXTURES = [
  {
    businessId: "00000000-0000-4000-8000-000000000601",
    userId: "00000000-0000-4000-8000-000000000701",
    email: "engine-v3-flags-601@example.test",
  },
  {
    businessId: "00000000-0000-4000-8000-000000000602",
    userId: "00000000-0000-4000-8000-000000000702",
    email: "engine-v3-flags-602@example.test",
  },
  {
    businessId: "00000000-0000-4000-8000-000000000603",
    userId: "00000000-0000-4000-8000-000000000703",
    email: "engine-v3-flags-603@example.test",
  },
  {
    businessId: "00000000-0000-4000-8000-000000000604",
    userId: "00000000-0000-4000-8000-000000000704",
    email: "engine-v3-flags-604@example.test",
  },
] as const;

function setFlagEnv(
  overrides: Partial<Record<(typeof FLAG_ENV_KEYS)[number], string>>,
) {
  for (const key of FLAG_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key as (typeof FLAG_ENV_KEYS)[number]] = value;
  }
}

function restoreFlagEnv() {
  for (const key of FLAG_ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

async function cleanupFixtures() {
  const db = getDb();
  const businessIds = FIXTURES.map((fixture) => fixture.businessId);
  const userIds = FIXTURES.map((fixture) => fixture.userId);
  const emails = FIXTURES.map((fixture) => fixture.email);

  await db.query(
    "DELETE FROM business_engine_v3_flags WHERE business_id = ANY($1::uuid[])",
    [businessIds],
  );
  await db.query("DELETE FROM businesses WHERE id = ANY($1::uuid[])", [
    businessIds,
  ]);
  await db.query(
    "DELETE FROM users WHERE id = ANY($1::uuid[]) OR email = ANY($2::text[])",
    [userIds, emails],
  );
}

async function setupFixtures() {
  const db = getDb();
  await cleanupFixtures();
  for (const fixture of FIXTURES) {
    await db.query(
      `
      INSERT INTO users (id, name, email, password_hash)
      VALUES ($1::uuid, $2, $3, $4)
      `,
      [
        fixture.userId,
        "Engine V3 Flags Test",
        fixture.email,
        "test-password-hash",
      ],
    );
    await db.query(
      `
      INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
      VALUES ($1::uuid, $2, $3::uuid, 'UTC', 'USD', true)
      `,
      [fixture.businessId, "Engine V3 Flags Fixture", fixture.userId],
    );
  }
}

async function upsertFlags(input: {
  businessId: string;
  enabled?: boolean | null;
  surfaceVisible?: boolean | null;
  shadowOnly?: boolean | null;
}) {
  await getDb().query(
    `
    INSERT INTO business_engine_v3_flags (
      business_id,
      enabled,
      surface_visible,
      shadow_only,
      notes,
      updated_by
    )
    VALUES ($1::uuid, $2::boolean, $3::boolean, $4::boolean, 'test override', 'vitest')
    ON CONFLICT (business_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      surface_visible = EXCLUDED.surface_visible,
      shadow_only = EXCLUDED.shadow_only,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    `,
    [
      input.businessId,
      input.enabled ?? null,
      input.surfaceVisible ?? null,
      input.shadowOnly ?? null,
    ],
  );
}

describe("readEnvDefaults", () => {
  afterEach(() => {
    restoreFlagEnv();
  });

  it("parses true, false, 1, 0, and missing defaults for all v3 flags", () => {
    setFlagEnv({});
    expect(readEnvDefaults()).toEqual({
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    });

    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "false",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "true",
      DECISION_ENGINE_V3_SHADOW_ONLY: "false",
    });
    expect(readEnvDefaults()).toEqual({
      enabled: false,
      surfaceVisible: true,
      shadowOnly: false,
    });

    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "1",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "1",
      DECISION_ENGINE_V3_SHADOW_ONLY: "0",
    });
    expect(readEnvDefaults()).toEqual({
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
    });

    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "0",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "0",
      DECISION_ENGINE_V3_SHADOW_ONLY: "1",
    });
    expect(readEnvDefaults()).toEqual({
      enabled: false,
      surfaceVisible: false,
      shadowOnly: true,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("engine v3 feature flags", () => {
  beforeAll(async () => {
    await runMigrations({ force: true, reason: "engine-v3-feature-flags-test" });
  });

  beforeEach(async () => {
    restoreFlagEnv();
    await setupFixtures();
  });

  afterEach(async () => {
    restoreFlagEnv();
    await cleanupFixtures();
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("resolves env defaults when there is no business override", async () => {
    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "false",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "true",
      DECISION_ENGINE_V3_SHADOW_ONLY: "false",
    });

    const flags = await resolveEngineV3Flags(FIXTURES[0].businessId);

    expect(flags).toMatchObject({
      businessId: FIXTURES[0].businessId,
      enabled: false,
      surfaceVisible: true,
      shadowOnly: false,
      source: {
        enabled: "env",
        surfaceVisible: "env",
        shadowOnly: "env",
      },
      envDefaults: {
        enabled: false,
        surfaceVisible: true,
        shadowOnly: false,
      },
    });
  });

  it("resolves full business overrides with business_override sources", async () => {
    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "false",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "false",
      DECISION_ENGINE_V3_SHADOW_ONLY: "true",
    });
    await upsertFlags({
      businessId: FIXTURES[1].businessId,
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
    });

    const flags = await resolveEngineV3Flags(FIXTURES[1].businessId);

    expect(flags).toMatchObject({
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
      source: {
        enabled: "business_override",
        surfaceVisible: "business_override",
        shadowOnly: "business_override",
      },
    });
  });

  it("resolves partial business overrides with mixed sources", async () => {
    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "true",
      DECISION_ENGINE_V3_SURFACE_VISIBLE: "true",
      DECISION_ENGINE_V3_SHADOW_ONLY: "false",
    });
    await upsertFlags({
      businessId: FIXTURES[2].businessId,
      enabled: false,
    });

    const flags = await resolveEngineV3Flags(FIXTURES[2].businessId);

    expect(flags).toMatchObject({
      enabled: false,
      surfaceVisible: true,
      shadowOnly: false,
      source: {
        enabled: "business_override",
        surfaceVisible: "env",
        shadowOnly: "env",
      },
    });
  });

  it("lists only businesses whose final enabled flag resolves to true", async () => {
    setFlagEnv({
      DECISION_ENGINE_V3_ENABLED: "false",
    });
    await upsertFlags({
      businessId: FIXTURES[1].businessId,
      enabled: true,
    });
    await upsertFlags({
      businessId: FIXTURES[2].businessId,
      enabled: false,
    });
    await upsertFlags({
      businessId: FIXTURES[3].businessId,
      enabled: null,
    });

    const ids = await listEnabledBusinessIds();

    expect(ids).toContain(FIXTURES[1].businessId);
    expect(ids).not.toContain(FIXTURES[0].businessId);
    expect(ids).not.toContain(FIXTURES[2].businessId);
    expect(ids).not.toContain(FIXTURES[3].businessId);
  });
});
