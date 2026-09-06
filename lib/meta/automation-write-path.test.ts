/**
 * The two properties this whole subsystem exists to guarantee.
 *
 * 1. There is exactly ONE provider-write path out of Automation, and it is the
 *    existing guarded entity-action handler, called from exactly one module.
 * 2. A rule firing cannot execute. It writes rows and stops; only the queue's
 *    approve action can reach that one path.
 *
 * These are asserted two ways on purpose. The source assertions catch a second
 * path being *added*; the runtime assertion catches the existing path being
 * *reached* by something that should not reach it.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every module that makes up rules + queue. If a file joins this subsystem it
 * belongs in this list, and the assertions below then apply to it.
 */
const SUBSYSTEM_FILES = [
  "lib/meta/automation-rules.ts",
  "lib/meta/automation-rules-store.ts",
  "lib/meta/automation-rules-evaluation.ts",
  "lib/meta/automation-rules-client.ts",
  "lib/meta/automation-guardrail-policy.ts",
  "lib/meta/automation-proposal-intake.ts",
  "lib/meta/automation-proposals.ts",
  "lib/meta/automation-proposal-execution.ts",
  "app/api/meta/automation/route.ts",
  "app/api/meta/automation/proposals/route.ts",
  "app/(dashboard)/platforms/meta/automation/automation-rules-exact-adapter.ts",
  "app/(dashboard)/platforms/meta/automation/automation-proposals-exact-adapter.ts",
] as const;

/** The single module allowed to call the guarded handler. */
const THE_WRITE_PATH = "lib/meta/automation-proposal-execution.ts";

function sourceOf(file: string) {
  return readFileSync(file, "utf8");
}

describe("exactly one provider-write path out of Automation", () => {
  it("names the guarded entity-action handler in exactly one module", () => {
    const callers = SUBSYSTEM_FILES.filter((file) =>
      sourceOf(file).includes("@/lib/meta/entity-action-routes"),
    );

    expect(callers).toEqual([THE_WRITE_PATH]);
  });

  it("names the guarded Launchpad handlers in exactly one module", () => {
    /**
     * The same law, extended to the families that arrived after it.
     *
     * A `launch` row and an activation `resume` row dispatch by forwarding to
     * the extracted Launchpad handlers. That is the whole reason those bodies
     * were moved out of `app/`, and it is only safe while there is ONE module
     * doing the forwarding — a second caller would be a second create path
     * with its own idea of the gates.
     */
    for (const handlerModule of [
      "@/lib/launchpad/meta-launch-route-handlers",
      "@/lib/meta/launch-activation-route-handlers",
    ]) {
      const callers = SUBSYSTEM_FILES.filter((file) =>
        sourceOf(file).includes(handlerModule),
      );

      expect(callers, handlerModule).toEqual([THE_WRITE_PATH]);
    }
  });

  it("invokes that handler from exactly one module", () => {
    const invocations = SUBSYSTEM_FILES.flatMap((file) => {
      const matches = sourceOf(file).match(
        /handleMetaEntity(Pause|Resume)Action\(/g,
      );
      return matches ? matches.map(() => file) : [];
    });

    expect(new Set(invocations)).toEqual(new Set([THE_WRITE_PATH]));
  });

  it("reaches no provider client from anywhere in the subsystem", () => {
    for (const file of SUBSYSTEM_FILES) {
      const source = sourceOf(file);
      // The Graph API, the Meta write client, the Google client and the raw
      // action log are all things a second path would need. None of them is
      // importable from here — including from the one module that dispatches,
      // which builds a request for the handler instead of a provider call.
      expect(source, file).not.toContain("graph.facebook");
      expect(source, file).not.toContain("@/lib/meta/ads-write");
      expect(source, file).not.toContain("@/lib/meta/ads-action-log");
      expect(source, file).not.toContain("googleads");
    }
  });

  it("keeps every server-side module free of an outbound fetch", () => {
    for (const file of SUBSYSTEM_FILES) {
      // The browser client is the one legitimate `fetch` — it calls this
      // product's own route, which is where the authorization chain lives.
      if (file === "lib/meta/automation-rules-client.ts") continue;
      expect(sourceOf(file), file).not.toMatch(/\bfetch\(/);
    }
  });

  it("dispatches only from the queue's approve action", () => {
    const route = sourceOf("app/api/meta/automation/proposals/route.ts");
    const dispatches =
      route.match(/executeMetaAutomationProposal\(/g)?.length ?? 0;

    // One import reference plus one call site, and the call site lives in
    // `approve`. `decideWithoutProviderWrite` — modify and dismiss — has none.
    expect(dispatches).toBe(1);
    // The slice ends at `approve`'s DOC COMMENT, not at its `async function`
    // line. The comment explains why the executor is called after the claim
    // and therefore names it; ending the slice below it put approve's own
    // prose inside the body this assertion is about, and the law would have
    // failed on a paragraph rather than on a call. The law is unchanged: no
    // dispatch may exist between these two boundaries.
    const decideBody = route.slice(
      route.indexOf("async function decideWithoutProviderWrite"),
      route.indexOf("/**\n * Approve."),
    );
    expect(decideBody).not.toContain("executeMetaAutomationProposal");
    expect(decideBody).toContain("providerWrite: false");

    // The sibling Automation route — which owns rule creation, the toggle and
    // the evaluation trigger — never dispatches at all.
    expect(sourceOf("app/api/meta/automation/route.ts")).not.toContain(
      "executeMetaAutomationProposal",
    );
  });

  it("lets no rules module import the executor", () => {
    for (const file of [
      "lib/meta/automation-rules.ts",
      "lib/meta/automation-rules-store.ts",
      "lib/meta/automation-rules-evaluation.ts",
      "lib/meta/automation-proposal-intake.ts",
    ]) {
      expect(sourceOf(file), file).not.toContain(
        "automation-proposal-execution",
      );
    }
  });
});

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/meta/entity-action-routes", () => ({
  handleMetaEntityPauseAction: vi.fn(),
  handleMetaEntityResumeAction: vi.fn(),
}));

const db = await import("@/lib/db");
const entityRoutes = await import("@/lib/meta/entity-action-routes");
const { recordRuleFirings } = await import("@/lib/meta/automation-rules-store");
const { evaluateProposalTransition } = await import(
  "@/lib/meta/automation-proposals"
);

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

type Statement = { text: string; values: unknown[] };

/**
 * A database double that records everything issued through either calling
 * convention this subsystem uses: the tagged template and `.query`.
 */
function recordingDb(statements: Statement[]) {
  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join("?"), values });
    return Promise.resolve(
      /INSERT INTO meta_automation_rule_firings/.test(strings.join(" "))
        ? [{ id: "firing_1" }]
        : [{ id: "proposal_1" }],
    );
  };
  (tagged as unknown as { query: unknown }).query = (
    text: string,
    values: unknown[],
  ) => {
    statements.push({ text, values });
    return Promise.resolve([{ id: "proposal_1" }]);
  };
  return tagged;
}

const RULE = {
  id: "11111111-1111-4111-8111-111111111111",
  businessId: BUSINESS_ID,
  name: "Breakeven guard",
  entityLevel: "adset" as const,
  trigger: {
    kind: "roas_below_anchor" as const,
    anchor: "break_even_roas" as const,
    anchorMultiplier: 1,
    consecutiveDays: 3,
  },
  action: { kind: "propose_pause" as const },
  mode: "confirm" as const,
  active: true,
  createdAt: null,
  updatedAt: null,
};

const FIRING = {
  status: "fires" as const,
  ruleId: RULE.id,
  entityId: "adset_1",
  entityLevel: "adset" as const,
  entityName: "Retargeting 7d — DPA",
  providerAccountId: "act_1",
  outcome: "proposal" as const,
  evaluatedForDate: "2026-08-16",
  dedupeKey: `${RULE.id}:adset_1:2026-08-16`,
  reason: "Breakeven guard: ROAS below breakeven 2.50 for 3 consecutive days.",
  evidence: {
    anchor: "break_even_roas" as const,
    anchorValue: 2.5,
    threshold: 2.5,
    consecutiveDays: 3,
    observed: [{ date: "2026-08-16", value: 1.9 }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a rule firing cannot execute without an approval", () => {
  it("writes a pending queue row and never touches the guarded handler", async () => {
    const statements: Statement[] = [];
    vi.mocked(db.getDb).mockReturnValue(recordingDb(statements) as never);

    // The REAL default sink — no stub — so this exercises the actual intake.
    const recorded = await recordRuleFirings({
      businessId: BUSINESS_ID,
      rules: [RULE],
      verdicts: [FIRING],
    });

    expect(recorded).toEqual([
      {
        ruleId: RULE.id,
        entityId: "adset_1",
        evaluatedForDate: "2026-08-16",
        outcome: "proposal_raised",
        proposalId: "proposal_1",
        inserted: true,
      },
    ]);

    // Nothing reached a provider. Not through the handler, not around it.
    expect(entityRoutes.handleMetaEntityPauseAction).not.toHaveBeenCalled();
    expect(entityRoutes.handleMetaEntityResumeAction).not.toHaveBeenCalled();

    // Every statement issued is an INSERT or UPDATE against this product's own
    // automation tables. No provider table, no action log, no dispatch.
    const targets = statements.map((statement) =>
      statement.text.replace(/\s+/g, " ").trim(),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const text of targets) {
      expect(text).toMatch(
        /meta_automation_rule_firings|meta_automation_proposals/,
      );
    }

    // The queue row it raised is `pending`, carries the rule origin, and names
    // an action the guarded path can actually perform.
    const queueInsert = targets.find((text) =>
      /INSERT INTO meta_automation_proposals/.test(text),
    );
    expect(queueInsert).toBeDefined();
    expect(queueInsert).toContain("'automation_rule'");
    expect(queueInsert).toContain("'pending'");
    const queueValues = statements.find((statement) =>
      /INSERT INTO meta_automation_proposals/.test(statement.text),
    )!.values;
    expect(queueValues).toContain("pause");
  });

  it("leaves the row in the one state the queue's own gate can move", () => {
    // A firing produces `pending` and nothing else, and `pending` is the only
    // status the transition function will act on. There is no path from a
    // firing to `approved` that does not go through an operator decision.
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const now = new Date();

    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt,
        action: "approve",
        now,
      }),
    ).toEqual({ ok: true, next: "approved" });

    for (const status of ["approved", "failed", "modified", "dismissed", "expired"] as const) {
      expect(
        evaluateProposalTransition({ status, expiresAt, action: "approve", now }),
      ).toMatchObject({ ok: false, refusal: "proposal_not_pending" });
    }
  });

  it("records a guard block as a row, never as a permitted write", async () => {
    const statements: Statement[] = [];
    vi.mocked(db.getDb).mockReturnValue(recordingDb(statements) as never);
    const { recordAutomationGuardBlock } = await import(
      "@/lib/meta/automation-rules-store"
    );

    await recordAutomationGuardBlock({
      businessId: BUSINESS_ID,
      ruleId: RULE.id,
      ruleName: "Quiet hours",
      reason: "Quiet hours: provider writes are hard-blocked.",
      providerAccountId: "act_1",
      at: new Date("2026-08-16T04:00:00.000Z"),
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]!.text.replace(/\s+/g, " ")).toContain(
      "INSERT INTO meta_automation_rule_firings",
    );
    expect(statements[0]!.text).toContain("'hard_block_recorded'");
    expect(entityRoutes.handleMetaEntityPauseAction).not.toHaveBeenCalled();
  });
});
