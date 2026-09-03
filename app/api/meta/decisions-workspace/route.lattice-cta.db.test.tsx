// @vitest-environment node
//
// D078 C2.2 — the stale/fresh mutation-CTA contract proven through the
// ACTUAL `/api/meta/decisions-workspace` GET route against a REAL
// (ephemeral) database that carries the constitutionally valid TheSwaf
// lattice, then through the real client adapter into rendered UI.
//
// What is REAL here: the exported route handler, the SQL read model, the
// freshness derivation (the shipped 12-hour evaluator inside the read
// model — this test never assigns executionReadiness or freshness), the
// governance/pipeline reads, the OS presentation, the exact adapter, and
// the rendered Decision Center HTML.
//
// What is mocked (correction 3, the complete ledger): ONLY the EXTERNAL
// current-provider-inventory boundary (`resolveMetaCredentials` +
// `fetchMetaActiveAdConfigsReceipt`), with a complete in-memory receipt
// naming the three seeded ads — no network or provider call exists
// anywhere (global fetch is stubbed to throw and asserted uncalled).
// Request auth is REAL: this test mints its own in-memory session token
// (crypto.randomBytes; only its sha256 touches the ephemeral DB) for the
// seeded QA user and sends it as a real `omniads_session` cookie, so
// `requireBusinessAccess` → `getSessionFromRequest` → the sessions/
// memberships tables all execute. The demo-vs-live posture read is REAL
// too: `readMetaBusinessDataPosture` reads the seeded
// `businesses.is_demo_business` row. The correction-2 revision of this
// file mocked both and still claimed "only the provider boundary" — that
// ledger was false and is corrected here; a guard test now scans this
// file for those two mocks.
//
// The rendered-queue test in this file is DECISION-INFORMATION proof
// only: the creative queue renders the served action as row text, and
// the one row control opens evidence. The actionable-control proof (real
// drawer, real enabled/withheld primary, real confirmation ceremony)
// lives in `drawer-cta.db.test.tsx`, driven by this same route's payload.
//
// Runs ONLY under the D078 local-UI harness, which seeds the cluster and
// sets D078_LATTICE_DB=1 + DATABASE_URL before spawning this file; without
// that environment every test is skipped (recorded honestly — the harness
// records the run's exit code in the acceptance matrix as routeCtaProof).
//
// Fail-first (C2.2.5): correction 1's proof fabricated the read model in
// the test and never invoked the route; this file's core assertions —
// `source.authority === "native_ad"` served by GET, and freshness values
// derived inside the route's own read — cannot pass through a fabricated
// model, and the matrix validator separately rejects any artifact whose
// routeCtaProof did not run and pass.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV } from "@/lib/creative-decision-engine/campaign-context/source";
import {
  D078_QA_FRESH_AD_ID,
  D078_QA_KEEP_AD_ID,
  D078_QA_THESWAF_BUSINESS_ID,
  D078_QA_THESWAF_MAIN,
} from "@/scripts/audits/d078-lattice-seed";

/*
  PRE-DEPLOY AUDIT — the production-tunnel refusal every other seeding DB test
  in this repository carries.

  This file SEEDS users, businesses, memberships, sessions and
  `meta_automation_business_controls` rows through `seedD078Fixture`. This
  machine's `.env.local` reaches PRODUCTION over an SSH tunnel on
  127.0.0.1:15432, which is exactly why `lib/meta/launchpad-handoff.db.test.ts`
  and `app/api/meta/launchpad-handoff/route.db.test.ts` refuse that port
  outright. Without it, `D078_LATTICE_DB=1` set outside the ephemeral harness
  writes QA rows into whatever `DATABASE_URL` happens to resolve to.

  It THROWS rather than skipping: a seam that was asked to run and silently did
  nothing is how a "green" run hides a misconfiguration.
*/
if (process.env.D078_LATTICE_DB === "1"
  && process.env.DATABASE_URL?.includes("15432")) {
  throw new Error(
    "D078 lattice DB seam refused: DATABASE_URL points at the production tunnel",
  );
}

const RUNNABLE =
  process.env.D078_LATTICE_DB === "1"
  && Boolean(process.env.DATABASE_URL)
  && !process.env.DATABASE_URL?.includes("15432");

// Run the account-pulse and lane-classify upstreams IN-PROCESS (a shipped
// transport option) so the real sibling route functions execute against the
// ephemeral database — no HTTP hop exists, and the global-fetch spy can
// prove zero network calls of any kind.
process.env.META_DECISIONS_UPSTREAM_TRANSPORT = "in_process";

const metaApiMock = vi.hoisted(() => ({
  resolveMetaCredentials: vi.fn(),
  fetchMetaActiveAdConfigsReceipt: vi.fn(),
}));
vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: metaApiMock.resolveMetaCredentials,
  fetchMetaActiveAdConfigsReceipt: metaApiMock.fetchMetaActiveAdConfigsReceipt,
}));

const networkSpy = vi.fn((...args: unknown[]) => {
  console.error(
    "[cta-proof] fetch attempted:",
    String(args[0]).slice(0, 200),
    new Error("origin").stack?.split("\n").slice(1, 6).join(" | "),
  );
  throw new Error("network access is forbidden in the CTA proof");
});

describe.skipIf(!RUNNABLE)(
  "actual-route stale/fresh CTA proof (D078 C2.2, DB-backed)",
  () => {
    let payload: never;
    let staleAdId = "";
    let sessionCookie = "";

    beforeAll(async () => {
      // D074: trusted-for-action roles are reachable only after the
      // deliberate operator act of validating the exact resolver version.
      // The gate is intentionally unset in production and in this shell;
      // stubbing it here is the test's process-scoped SIMULATION of that
      // act (repo-established practice, mirrored from the native-pause
      // suite), never a real environment change.
      vi.stubEnv(
        CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
        CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      );
      vi.stubGlobal("fetch", networkSpy);
      const { Client } = await import("pg");
      const { createHash, randomBytes } = await import("node:crypto");
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const staleRow = await client.query(
        `SELECT ad_id FROM engine_v3_ad_decision_snapshots_daily
          WHERE business_id = $1 AND provider_account_id = $2
            AND authorized_action = 'cut' AND ad_id <> $3
          ORDER BY computed_at ASC LIMIT 1`,
        [D078_QA_THESWAF_BUSINESS_ID, D078_QA_THESWAF_MAIN, D078_QA_FRESH_AD_ID],
      );
      // REAL request auth: a fresh in-memory token for the seeded QA user;
      // only its sha256 is written, into the throwaway cluster.
      const token = randomBytes(32).toString("hex");
      const userRow = await client.query(
        `SELECT id FROM users WHERE email = 'qa-d078@ephemeral.invalid'`,
      );
      await client.query(
        `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [
          userRow.rows[0].id,
          createHash("sha256").update(token).digest("hex"),
          D078_QA_THESWAF_BUSINESS_ID,
        ],
      );
      sessionCookie = `omniads_session=${token}`;
      await client.end();
      staleAdId = String(staleRow.rows[0]?.ad_id ?? "");

      metaApiMock.resolveMetaCredentials.mockResolvedValue({
        accountIds: [D078_QA_THESWAF_MAIN],
        accessToken: "qa-inventory-boundary",
      });
      metaApiMock.fetchMetaActiveAdConfigsReceipt.mockResolvedValue({
        complete: true,
        termination: "exhausted",
        rows: [staleAdId, D078_QA_FRESH_AD_ID, D078_QA_KEEP_AD_ID].map(
          (adId) => ({
            id: adId,
            name: `SEED_${adId.slice(-6)}`,
            status: "ACTIVE",
            effective_status: "ACTIVE",
            campaign_id: "c-seed",
            adset_id: "as-seed",
            creative: { id: `cr_${adId.slice(-6)}` },
            updated_time: "2026-08-29T00:00:00+0000",
          }),
        ),
      });

      const route = await import(
        "@/app/api/meta/decisions-workspace/route"
      );
      const accountsRoute = await import(
        "@/app/api/meta/history/accounts/route"
      );
      const accountsResponse = await accountsRoute.GET(
        new NextRequest(
          `http://localhost/api/meta/history/accounts?businessId=${D078_QA_THESWAF_BUSINESS_ID}`,
          { headers: { cookie: sessionCookie } },
        ),
      );
      expect(accountsResponse.status).toBe(200);
      const accountsPayload = (await accountsResponse.json()) as {
        accounts: unknown[];
      };
      const response = await route.GET(
        new NextRequest(
          `http://localhost/api/meta/decisions-workspace?businessId=${D078_QA_THESWAF_BUSINESS_ID}&providerAccountId=${D078_QA_THESWAF_MAIN}&window=28d`,
          { headers: { cookie: sessionCookie } },
        ),
      );
      if (response.status !== 200) {
        // Surface the route's own error body for diagnosis before failing.
        console.error(
          "[cta-proof] route error body:",
          JSON.stringify(await response.json()).slice(0, 1200),
        );
      }
      expect(response.status).toBe(200);
      payload = (await response.json()) as never;
      const diag = payload as {
        decisionReadModel?: {
          status?: string;
          source?: unknown;
          unavailable?: unknown;
          capabilities?: unknown;
        };
      };
      console.error(
        "[cta-proof] pipelineHealth:",
        JSON.stringify(
          (payload as { system?: { pipelineHealth?: unknown } }).system
            ?.pipelineHealth,
        ).slice(0, 900),
      );
      console.error(
        "[cta-proof] readModel status:",
        diag.decisionReadModel?.status,
        "source:",
        JSON.stringify(diag.decisionReadModel?.source).slice(0, 400),
        "unavailable:",
        JSON.stringify(diag.decisionReadModel?.unavailable).slice(0, 500),
      );
      // C3.2: hand the ACTUAL route payload (and the actual accounts-route
      // response) to the jsdom drawer proof, which cannot import server
      // modules (the jsdom web transform breaks pg/route imports — the
      // reason the drawer proof is a separate file). The handoff path is a
      // runner-owned file inside the ephemeral cluster's temp directory,
      // deleted with it; it carries decision data only, never a credential.
      if (process.env.D078_CTA_HANDOFF) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          process.env.D078_CTA_HANDOFF,
          JSON.stringify({
            payload,
            accounts: accountsPayload.accounts,
            staleAdId,
            freshAdId: D078_QA_FRESH_AD_ID,
            businessId: D078_QA_THESWAF_BUSINESS_ID,
            mainAccountId: D078_QA_THESWAF_MAIN,
          }),
        );
      }
    }, 120_000);

    afterAll(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    function osItems() {
      return (
        payload as {
          os: { ads: { items: Array<Record<string, never>> } };
        }
      ).os.ads.items as unknown as Array<{
        id: string;
        adId: string;
        lane: string;
        action: {
          code: string;
          label: string;
          intent: string;
          providerMutation: string | null;
          scopeNote: string;
        };
      }>;
    }

    function canonicalByAd(adId: string) {
      const sections = (
        payload as {
          decisionReadModel: {
            queue: {
              sections: Record<
                string,
                { items: Array<Record<string, never>> }
              >;
            };
          };
        }
      ).decisionReadModel.queue.sections;
      for (const section of Object.values(sections)) {
        for (const item of section.items as Array<{
          parentChain?: { ad?: { id?: string } };
          sourceAuthority?: {
            executionReadiness?: string;
            decisionFreshness?: { status?: string; ageHours?: number | null };
          };
        }>) {
          if (item.parentChain?.ad?.id === adId) return item;
        }
      }
      return null;
    }

    it("the ACTUAL route served the native lane with both exact Ad rows", () => {
      const source = (
        payload as {
          decisionReadModel: { source: { authority: string; table: string } };
        }
      ).decisionReadModel.source;
      expect(source.authority).toBe("native_ad");
      expect(source.table).toBe("engine_v3_ad_decision_snapshots_daily");
      const ids = osItems().map((item) => item.adId);
      expect(ids).toContain(staleAdId);
      expect(ids).toContain(D078_QA_FRESH_AD_ID);
    });

    it("freshness was DERIVED by the shipped evaluator inside the route's read — not assigned", () => {
      const stale = canonicalByAd(staleAdId)!;
      const fresh = canonicalByAd(D078_QA_FRESH_AD_ID)!;
      expect(stale.sourceAuthority?.decisionFreshness?.status).toBe("stale");
      expect(
        stale.sourceAuthority?.decisionFreshness?.ageHours ?? 0,
      ).toBeGreaterThan(150);
      expect(stale.sourceAuthority?.executionReadiness).toBe("stale_decision");
      expect(fresh.sourceAuthority?.decisionFreshness?.status).toBe("fresh");
      expect(fresh.sourceAuthority?.executionReadiness).toBe(
        "live_preflight_required",
      );
    });

    it("stale ⇒ review-only Refresh Decision with provider mutation null; fresh ⇒ supervised Cut with explicit live-preflight copy", () => {
      const stale = osItems().find((item) => item.adId === staleAdId)!;
      const fresh = osItems().find(
        (item) => item.adId === D078_QA_FRESH_AD_ID,
      )!;
      expect(stale.lane).toBe("blocked");
      expect(stale.action).toMatchObject({
        code: "refresh_decision_data",
        label: "Refresh Decision",
        intent: "review",
        providerMutation: null,
      });
      expect(fresh.action).toMatchObject({
        label: "Cut",
        intent: "execute",
        providerMutation: "pause",
      });
      expect(fresh.action.scopeNote).toMatch(/live preflight/i);
    });

    it("the rendered queue (real adapter, ROUTE payload) carries each served action as DECISION-INFORMATION text, scoped to the exact row", async () => {
      const { buildMetaDecisionCenterExactViewModel } = await import(
        "@/components/meta/decision-center/meta-decision-center-exact-adapter"
      );
      const { MetaDecisionCenterExact } = await import(
        "@/components/meta/decision-center/MetaDecisionCenterExact"
      );
      const viewModel = buildMetaDecisionCenterExactViewModel({
        workspace: payload,
        now: new Date(),
      });
      const html = renderToStaticMarkup(
        <MetaDecisionCenterExact viewModel={viewModel} defaultScope="creatives" />,
      );

      // C3.2.7 would-have-failed probe: the correction-2 revision scoped its
      // "no enabled Cut" assertion to `data-decision-id` — an attribute this
      // surface has NEVER emitted — and a `?? ""` fallback made the absent
      // region pass vacuously. Pin the premise: the attribute must not
      // exist, and the extractor below throws instead of falling back.
      expect(html).not.toContain("data-decision-id=");

      const region = (rowId: string): string => {
        const match = html.match(
          new RegExp(
            `<article[^>]*data-meta-exact-creative-row="${rowId}"[^>]*>[^]*?</article>`,
          ),
        );
        if (!match) {
          throw new Error(`creative row region not rendered: ${rowId}`);
        }
        return match[0];
      };
      // The extractor genuinely fails on an absent region — no silent "".
      expect(() => region("row_that_does_not_exist")).toThrow(
        /not rendered/,
      );

      const staleRow = osItems().find((item) => item.adId === staleAdId)!;
      const freshRow = osItems().find(
        (item) => item.adId === D078_QA_FRESH_AD_ID,
      )!;
      const staleRegion = region(staleRow.id);
      const freshRegion = region(freshRow.id);
      // The served action is row TEXT (decision information); the row's only
      // button is the evidence opener. The actionable-control proof — real
      // drawer, enabled/withheld primary, confirmation ceremony — is the
      // sibling drawer test's job, on this same route payload.
      expect(staleRegion).toContain(
        'data-meta-exact-creative-served-action="Refresh Decision"',
      );
      expect(staleRegion).not.toContain(
        'data-meta-exact-creative-served-action="Cut"',
      );
      expect(freshRegion).toContain(
        'data-meta-exact-creative-served-action="Cut"',
      );
      expect(staleRegion).toContain('data-meta-exact-creative-review="true"');
    });

    it("zero provider/network calls: only the mocked inventory boundary was touched", () => {
      expect(networkSpy).not.toHaveBeenCalled();
      expect(metaApiMock.fetchMetaActiveAdConfigsReceipt).toHaveBeenCalledWith(
        D078_QA_THESWAF_MAIN,
        "qa-inventory-boundary",
      );
    });
  },
);

describe.skipIf(RUNNABLE)("actual-route CTA proof placeholder", () => {
  it("is skipped without the D078 harness-provided ephemeral database", () => {
    expect(RUNNABLE).toBe(false);
  });
});
