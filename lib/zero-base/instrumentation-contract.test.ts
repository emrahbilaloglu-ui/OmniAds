import { describe, expect, it } from "vitest";

import {
  MAX_PROPERTIES_BYTES,
  findInstrumentationRow,
  validateInstrumentationEvent,
  widthBucketFor,
} from "@/lib/zero-base/instrumentation-contract";
import {
  V1_EVENT_NAMES,
  V1_SURFACES,
  ZERO_BASE_EVENTS,
  ZERO_BASE_SURFACES,
  instrumentationV2UpgradeStatements,
} from "@/lib/zero-base/instrumentation-schema";
import { GENERATED_INSTRUMENTATION, GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";

const authed = {
  authenticated: true,
  actorRole: "collaborator" as const,
  widthBucket: "w1280" as const,
};
const anonymous = {
  authenticated: false,
  actorRole: "anonymous" as const,
  widthBucket: "w390" as const,
};

describe("74 screen emitters, exactly", () => {
  it("declares one row per canonical leaf", () => {
    expect(GENERATED_INSTRUMENTATION).toHaveLength(74);
    expect(GENERATED_INSTRUMENTATION).toHaveLength(GENERATED_LEAVES.length);
  });

  it("maps every leaf exactly once, with no orphan and no duplicate", () => {
    const leaves = GENERATED_LEAVES.map((leaf) => leaf.leaf).sort();
    const emitters = GENERATED_INSTRUMENTATION.map((row) => row.leaf).sort();
    expect(emitters).toEqual(leaves);
    expect(new Set(emitters).size).toBe(74);
  });

  it("uses one surface token per leaf", () => {
    expect(new Set(GENERATED_INSTRUMENTATION.map((row) => row.surface)).size).toBe(74);
  });

  it("permits anonymous emission only where the ledger says there is no session", () => {
    /*
     * Seventeen, not fifteen. The ledger has six `actorScope` values and two of
     * them describe a caller with no session: `Public · pre-auth` (15 leaves)
     * and `Unauthenticated recipient · token scope only` (the public creative
     * and report shares).
     *
     * The generator matched only the first, so both share leaves came out
     * `anonymous: false` — and the ingest then refused the very pages the
     * ledger records as `availability: live` for an unauthenticated recipient.
     * That was a derivation bug, not a design statement, and this assertion
     * previously pinned it in place.
     */
    const anonymousRows = GENERATED_INSTRUMENTATION.filter((row) => row.anonymous);
    expect(anonymousRows).toHaveLength(17);

    const publicLeaves = new Set(
      GENERATED_LEAVES.filter((leaf) => leaf.ctx === "Public").map((leaf) => leaf.leaf),
    );
    /** The two token-scope recipients, named so a third cannot join quietly. */
    const TOKEN_SCOPE_LEAVES = new Set(["L-SH-CREATIVE", "L-SH-REPORT"]);

    for (const row of anonymousRows) {
      expect(
        publicLeaves.has(row.leaf) || TOKEN_SCOPE_LEAVES.has(row.leaf),
        `${row.leaf} is emitted anonymously and is neither pre-auth nor token-scoped`,
      ).toBe(true);
    }
    for (const leaf of TOKEN_SCOPE_LEAVES) {
      expect(
        anonymousRows.some((row) => row.leaf === leaf),
        `${leaf} has an unauthenticated recipient and cannot emit`,
      ).toBe(true);
    }
  });

  it("declares only server-derivable or opaque-id properties", () => {
    const permitted = new Set([
      "surface", "ts", "actor_role", "width_bucket", "business_id",
      "account_id", "creative_id", "report_id", "provider", "code_id",
      "user_id", "agency_scope", "token_hash",
    ]);
    for (const row of GENERATED_INSTRUMENTATION) {
      for (const key of row.properties) expect(permitted.has(key), `${row.surface}:${key}`).toBe(true);
    }
  });

  it("never declares a raw URL or query property", () => {
    for (const row of GENERATED_INSTRUMENTATION) {
      for (const key of row.properties) {
        expect(key, row.surface).not.toMatch(/url|query|path|search|referrer|email|name/i);
      }
    }
  });
});

describe("closed allowlist", () => {
  it("accepts a declared pair", () => {
    const result = validateInstrumentationEvent(
      { surface: "pub_home", event: "screen_view" },
      anonymous,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an undeclared pair with 400", () => {
    const result = validateInstrumentationEvent(
      { surface: "pub_home", event: "made_up_event" },
      authed,
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "unknown_pair", status: 400 } });
  });

  it("rejects an undeclared surface with 400", () => {
    const result = validateInstrumentationEvent(
      { surface: "not_a_surface", event: "screen_view" },
      authed,
    );
    expect(result).toMatchObject({ ok: false, rejection: { status: 400 } });
  });
});

describe("anonymous restriction", () => {
  it("refuses a non-public surface without a session", () => {
    const scoped = GENERATED_INSTRUMENTATION.find((row) => !row.anonymous)!;
    const result = validateInstrumentationEvent(
      { surface: scoped.surface, event: scoped.event },
      anonymous,
    );
    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "anonymous_not_permitted", status: 403 },
    });
  });

  it("allows the same surface once authenticated", () => {
    const scoped = GENERATED_INSTRUMENTATION.find((row) => !row.anonymous)!;
    expect(
      validateInstrumentationEvent({ surface: scoped.surface, event: scoped.event }, authed).ok,
    ).toBe(true);
  });
});

describe("server-derived fields", () => {
  it("substitutes actor_role and width_bucket rather than trusting the client", () => {
    const scoped = GENERATED_INSTRUMENTATION.find(
      (row) => row.properties.includes("actor_role") && !row.anonymous,
    )!;
    const result = validateInstrumentationEvent(
      {
        surface: scoped.surface,
        event: scoped.event,
        // A client claiming to be a platform admin must not become one.
        properties: { actor_role: "platform_admin", width_bucket: "w1440" },
      },
      authed,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.actorRole).toBe("collaborator");
      expect(result.event.widthBucket).toBe("w1280");
      // The submitted copies are dropped, not stored.
      expect(result.event.properties).not.toHaveProperty("actor_role");
      expect(result.event.properties).not.toHaveProperty("width_bucket");
    }
  });

  it("buckets viewport widths at the design's breakpoints", () => {
    expect(widthBucketFor(320)).toBe("w320");
    expect(widthBucketFor(389)).toBe("w320");
    expect(widthBucketFor(390)).toBe("w390");
    expect(widthBucketFor(767)).toBe("w390");
    expect(widthBucketFor(768)).toBe("w768");
    expect(widthBucketFor(1280)).toBe("w1280");
    expect(widthBucketFor(1440)).toBe("w1440");
    expect(widthBucketFor(2560)).toBe("w1440");
  });
});

describe("property validation", () => {
  const withReport = GENERATED_INSTRUMENTATION.find((row) =>
    row.properties.includes("report_id"),
  )!;

  it("rejects a property the surface does not declare, with 400", () => {
    const result = validateInstrumentationEvent(
      { surface: withReport.surface, event: withReport.event, properties: { campaign_name: "x" } },
      authed,
    );
    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "disallowed_property", status: 400 },
    });
  });

  it("rejects a value that is not an opaque id — no URLs, no prose", () => {
    for (const value of [
      "https://app.example/reports?q=secret",
      "Summer sale — 30% off",
      "a".repeat(65),
      "has space",
    ]) {
      const result = validateInstrumentationEvent(
        { surface: withReport.surface, event: withReport.event, properties: { report_id: value } },
        authed,
      );
      expect(result, value).toMatchObject({ ok: false, rejection: { status: 400 } });
    }
  });

  it("rejects an oversized payload with 413", () => {
    const result = validateInstrumentationEvent(
      {
        surface: withReport.surface,
        event: withReport.event,
        properties: { report_id: "r".repeat(4000) },
      },
      authed,
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "payload_too_large", status: 413 } });
    expect(MAX_PROPERTIES_BYTES).toBe(2048);
  });

  it("requires a UUID event id when one is supplied", () => {
    expect(
      validateInstrumentationEvent(
        { surface: "pub_home", event: "screen_view", eventId: "not-a-uuid" },
        anonymous,
      ),
    ).toMatchObject({ ok: false, rejection: { status: 400 } });

    expect(
      validateInstrumentationEvent(
        {
          surface: "pub_home",
          event: "screen_view",
          eventId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        },
        anonymous,
      ).ok,
    ).toBe(true);
  });
});

describe("v2 schema upgrade", () => {
  const statements = instrumentationV2UpgradeStatements();
  const sql = statements.join("\n");

  it("creates no second telemetry table", () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toContain("product_ui_events");
    for (const statement of statements) {
      expect(statement).toMatch(/product_instrumentation_events/);
    }
  });

  it("adds every v2 column as nullable, so v1 rows stay valid", () => {
    for (const column of ["event_id", "actor_role", "width_bucket", "account_id", "properties"]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS \w+ \w+ NOT NULL/);
  });

  it("makes the event-id index partial so v1 NULLs cannot collide", () => {
    expect(sql).toContain("WHERE event_id IS NOT NULL");
  });

  it("widens the vocabularies instead of replacing them", () => {
    for (const name of V1_EVENT_NAMES) expect(sql, name).toContain(`'${name}'`);
    for (const surface of V1_SURFACES) expect(sql, surface).toContain(`'${surface}'`);
    for (const surface of ZERO_BASE_SURFACES) expect(sql, surface).toContain(`'${surface}'`);
    for (const event of ZERO_BASE_EVENTS) expect(sql, event).toContain(`'${event}'`);
  });

  it("keeps both contract versions accepted during rollout", () => {
    expect(sql).toContain("'product-instrumentation-event.v1'");
    expect(sql).toContain("'product-instrumentation-event.v2'");
  });

  it("bounds the properties payload and constrains account_id", () => {
    expect(sql).toContain("length(properties::text) <= 2048");
    // account_id is opaque, so a pattern does the work an allowlist cannot:
    // it bans slashes, colons and spaces, so a URL cannot land there.
    expect(sql).toContain("account_id ~ '^[A-Za-z0-9_-]{1,64}$'");
  });

  it("requires the server-derived fields on v2 rows only", () => {
    expect(sql).toContain("contract_version <> 'product-instrumentation-event.v2'");
    expect(sql).toContain("actor_role IS NOT NULL AND width_bucket IS NOT NULL");
  });

  it("is idempotent, so from-zero and upgrade run the same statements", () => {
    for (const statement of statements) {
      expect(
        /IF NOT EXISTS|DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT/.test(statement),
        statement.slice(0, 60),
      ).toBe(true);
    }
  });
});

describe("emitter coverage", () => {
  it("has a row for every leaf the shell can navigate to", () => {
    for (const leaf of GENERATED_LEAVES) {
      expect(findInstrumentationRow(leaf.surface, "screen_view"), leaf.leaf).not.toBeNull();
    }
  });
});
