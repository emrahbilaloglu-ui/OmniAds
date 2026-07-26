import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDbWithTimeout = vi.fn();

vi.mock("@/lib/db", () => ({
  getDbWithTimeout,
}));

const planner = await import("@/lib/sync/legacy-cleanup-planner");

type LegacyCleanupReceipt = Parameters<
  typeof planner.authorizeLegacyCleanupExecution
>[0]["receipts"][number];
type LegacyCleanupReceiptKind = LegacyCleanupReceipt["kind"];

function installQuery(rows: Array<{ id: string; observed_at: string; payload_hash: string }>) {
  const query = vi.fn().mockResolvedValue(rows);
  getDbWithTimeout.mockReturnValue({ query } as never);
  return query;
}

const CUTOFF = "2026-01-01T00:00:00.000Z";

const FINGERPRINT = {
  databaseIdentity: "adsecute:7300000000000000000",
  schemaDigest: "schema-digest",
  dataFingerprint: "data-fingerprint",
};

function receipt(
  kind: LegacyCleanupReceiptKind,
  planDigest: string,
  overrides: Partial<LegacyCleanupReceipt> = {},
): LegacyCleanupReceipt {
  return {
    kind,
    planDigest,
    cutoff: CUTOFF,
    databaseIdentity: FINGERPRINT.databaseIdentity,
    schemaDigest: FINGERPRINT.schemaDigest,
    dataFingerprint: FINGERPRINT.dataFingerprint,
    issuedAt: "2026-02-01T12:00:00.000Z",
    ...(kind === "restored_backup"
      ? { isolatedDatabaseIdentity: "adsecute_restore:7300000000000000001" }
      : {}),
    ...overrides,
  };
}

const NOW = "2026-02-01T12:30:00.000Z";

describe("the module ships no executable deletion path", () => {
  it("contains no mutating SQL anywhere in the source", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/sync/legacy-cleanup-planner.ts"),
      "utf8",
    );
    // Read from the file rather than trusting the exported constants: a delete
    // added anywhere in the module — behind a flag, a helper, or a template —
    // fails here.
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDROP\s+(TABLE|INDEX)\b/i,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });

  it("exports nothing that acts on a plan", () => {
    // Names that would mean "carry out the plan". `collectLegacyCleanupReceipts`
    // deliberately does not match: it collects EVIDENCE, reads only, and its
    // read-only-ness is enforced by the source-level check above rather than by
    // its name.
    for (const name of Object.keys(planner)) {
      expect(name).not.toMatch(
        /^(execute|apply|run|perform|commit|delete|purge|prune|collectGarbage)/i,
      );
      expect(name).not.toMatch(/(Execution|Cleanup)(Executor|Runner|Applier)$/);
    }
  });

  it("has no exported function that both takes an authority and returns", () => {
    // The authority type exists so a future executor cannot be written without
    // verification. Today nothing consumes one, which is the actual guarantee —
    // possessing an authority, genuine or fabricated, accomplishes nothing.
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/sync/legacy-cleanup-planner.ts"),
      "utf8",
    );
    const consumers = source.match(
      /authority:\s*LegacyCleanupExecutionAuthority/g,
    );
    expect(consumers).toBeNull();
  });

  it("issues only SELECT statements when planning", async () => {
    const query = installQuery([]);
    await planner.planLegacyCleanup({ target: "meta_orphan_legacy", cutoff: CUTOFF });
    await planner.planLegacyCleanup({
      target: "shopify_legacy_duplicate",
      cutoff: CUTOFF,
    });
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(String(call[0]).trimStart().startsWith("SELECT")).toBe(true);
    }
  });
});

describe("planLegacyCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is bounded and clamps an unbounded batch size", async () => {
    const query = installQuery([]);
    const plan = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
      batchSize: 10_000_000,
    });
    expect(plan.batchSize).toBe(5_000);
    expect(query.mock.calls[0]![1]).toContain(5_000);
    expect(plan.dryRun).toBe(true);
  });

  it("is deterministic: identical inputs produce an identical digest", async () => {
    const rows = [
      { id: "a", observed_at: "2025-12-01T00:00:00.000Z", payload_hash: "h1" },
      { id: "b", observed_at: "2025-12-02T00:00:00.000Z", payload_hash: "h2" },
    ];
    installQuery(rows);
    const first = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });
    installQuery(rows);
    const second = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });
    expect(second.planDigest).toEqual(first.planDigest);
  });

  it("binds the digest to the candidate set, cutoff and target", async () => {
    const rows = [{ id: "a", observed_at: "2025-12-01T00:00:00.000Z", payload_hash: "h1" }];
    installQuery(rows);
    const baseline = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });

    installQuery(rows);
    const otherCutoff = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: "2026-01-02T00:00:00.000Z",
    });
    expect(otherCutoff.planDigest).not.toEqual(baseline.planDigest);

    installQuery(rows);
    const otherTarget = await planner.planLegacyCleanup({
      target: "shopify_legacy_duplicate",
      cutoff: CUTOFF,
    });
    expect(otherTarget.planDigest).not.toEqual(baseline.planDigest);

    installQuery([{ id: "a", observed_at: "2025-12-01T00:00:00.000Z", payload_hash: "h9" }]);
    const otherData = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });
    expect(otherData.planDigest).not.toEqual(baseline.planDigest);
  });

  it("is restartable: a full batch opens a cursor, a short batch closes it", async () => {
    installQuery([
      { id: "a", observed_at: "2025-12-01T00:00:00.000Z", payload_hash: "h1" },
      { id: "b", observed_at: "2025-12-02T00:00:00.000Z", payload_hash: "h2" },
    ]);
    const full = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
      batchSize: 2,
    });
    expect(full.nextCursor).toEqual({
      observedAt: "2025-12-02T00:00:00.000Z",
      id: "b",
    });

    const query = installQuery([
      { id: "c", observed_at: "2025-12-03T00:00:00.000Z", payload_hash: "h3" },
    ]);
    const tail = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
      batchSize: 2,
      resumeAfter: full.nextCursor,
    });
    // The cursor must reach the query, or a restart would re-emit the batch it
    // already produced.
    expect(query.mock.calls[0]![1]).toContain("2025-12-02T00:00:00.000Z");
    expect(tail.nextCursor).toBeNull();
  });
});

describe("authorizeLegacyCleanupExecution", () => {
  const plan = {
    planVersion: "v1",
    target: "meta_orphan_legacy" as const,
    cutoff: CUTOFF,
    batchSize: 500,
    candidates: [],
    nextCursor: null,
    planDigest: "plan-digest",
    dryRun: true as const,
  };

  it("admits a complete, exact, fresh receipt set", () => {
    const authority = planner.authorizeLegacyCleanupExecution({
      plan,
      fingerprint: FINGERPRINT,
      receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
        receipt(kind, plan.planDigest),
      ),
      now: NOW,
    });
    expect(authority.planDigest).toBe("plan-digest");
  });

  it.each(planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS)(
    "refuses when the %s receipt is missing",
    (missing) => {
      expect(() =>
        planner.authorizeLegacyCleanupExecution({
          plan,
          fingerprint: FINGERPRINT,
          receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.filter(
            (kind) => kind !== missing,
          ).map((kind) => receipt(kind, plan.planDigest)),
          now: NOW,
        }),
      ).toThrow(`missing_receipt:${missing}`);
    },
  );

  it("refuses a receipt forged for a different plan", () => {
    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
          kind === "reader_equivalence"
            ? receipt(kind, "some-other-plan")
            : receipt(kind, plan.planDigest),
        ),
        now: NOW,
      }),
    ).toThrow("plan_mismatch:reader_equivalence");
  });

  it("refuses receipts that do not match the live database", () => {
    for (const [field, reason] of [
      ["databaseIdentity", "database_mismatch"],
      ["schemaDigest", "schema_mismatch"],
      ["dataFingerprint", "data_mismatch"],
      ["cutoff", "cutoff_mismatch"],
    ] as const) {
      expect(() =>
        planner.authorizeLegacyCleanupExecution({
          plan,
          fingerprint: FINGERPRINT,
          receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
            receipt(kind, plan.planDigest, { [field]: "drifted" }),
          ),
          now: NOW,
        }),
      ).toThrow(reason);
    }
  });

  it("refuses stale and future-dated evidence", () => {
    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
          receipt(kind, plan.planDigest, { issuedAt: "2026-01-01T00:00:00.000Z" }),
        ),
        now: NOW,
      }),
    ).toThrow("stale_receipt");

    // Future-dated evidence is the same failure wearing a different clock.
    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
          receipt(kind, plan.planDigest, { issuedAt: "2027-01-01T00:00:00.000Z" }),
        ),
        now: NOW,
      }),
    ).toThrow("stale_receipt");
  });

  it("refuses a duplicate receipt standing in for a missing one", () => {
    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: [
          receipt("reader_equivalence", plan.planDigest),
          receipt("reader_equivalence", plan.planDigest),
          receipt("fk_pit_equivalence", plan.planDigest),
          receipt("restored_backup", plan.planDigest),
        ],
        now: NOW,
      }),
    ).toThrow("ambiguous_receipt:reader_equivalence");
  });

  it("refuses a restore receipt taken from the live database", () => {
    // Verifying the restore against the live database is circular: it proves
    // nothing about whether the backup can actually be restored.
    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
          kind === "restored_backup"
            ? receipt(kind, plan.planDigest, {
                isolatedDatabaseIdentity: FINGERPRINT.databaseIdentity,
              })
            : receipt(kind, plan.planDigest),
        ),
        now: NOW,
      }),
    ).toThrow("restore_not_isolated");

    expect(() =>
      planner.authorizeLegacyCleanupExecution({
        plan,
        fingerprint: FINGERPRINT,
        receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
          kind === "restored_backup"
            ? receipt(kind, plan.planDigest, { isolatedDatabaseIdentity: undefined })
            : receipt(kind, plan.planDigest),
        ),
        now: NOW,
      }),
    ).toThrow("missing_isolated_restore_identity");
  });

  it("does not treat a private symbol as unforgeable", () => {
    // Documented honestly rather than claimed: the brand makes accidental
    // construction inconvenient, not impossible. Anything in-process can
    // reproduce the shape. The guarantee is that nothing consumes it.
    const real = planner.authorizeLegacyCleanupExecution({
      plan,
      fingerprint: FINGERPRINT,
      receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
        receipt(kind, plan.planDigest),
      ),
      now: NOW,
    });
    const brand = Object.getOwnPropertySymbols(real)[0]!;
    const fabricated = { [brand]: true, planDigest: "anything", verifiedAt: NOW };
    // A fabricated value is structurally identical. That is fine, and is
    // exactly why the safety argument does not rest on the type.
    expect(Object.getOwnPropertySymbols(fabricated)).toHaveLength(1);
    expect(fabricated[brand as unknown as keyof typeof fabricated]).toBe(true);
  });

  it("cannot be bypassed by env vars, config, or a cast", () => {
    // Environment is not an input at all — the signature takes plan,
    // fingerprint, receipts and now, and reads nothing else.
    const saved = { ...process.env };
    process.env.LEGACY_CLEANUP_OVERRIDE = "enabled";
    process.env.LEGACY_CLEANUP_FORCE = "1";
    process.env.SYNC_LEGACY_CLEANUP_EXECUTE = "true";
    try {
      expect(() =>
        planner.authorizeLegacyCleanupExecution({
          plan,
          fingerprint: FINGERPRINT,
          receipts: [],
          now: NOW,
        }),
      ).toThrow(planner.LegacyCleanupAuthorityRefusal);
    } finally {
      process.env = saved;
    }

    // A JSON round-trip drops the symbol, so config or a parsed payload cannot
    // accidentally become an authority. In-process code can still reproduce it;
    // see the test above.
    const parsed = JSON.parse(
      JSON.stringify({ planDigest: "plan-digest", verifiedAt: NOW }),
    ) as Record<string, unknown>;
    expect(Object.getOwnPropertySymbols(parsed)).toHaveLength(0);

    const real = planner.authorizeLegacyCleanupExecution({
      plan,
      fingerprint: FINGERPRINT,
      receipts: planner.REQUIRED_LEGACY_CLEANUP_RECEIPTS.map((kind) =>
        receipt(kind, plan.planDigest),
      ),
      now: NOW,
    });
    expect(Object.getOwnPropertySymbols(real)).toHaveLength(1);
  });
});
