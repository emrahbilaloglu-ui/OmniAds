// D078 acceptance guards (correction 1).
//
// R1 — artifact scope: every business_id / provider_account_id occurring in
// the frozen evidence bundle OUTSIDE payload.fleetGlobal must belong to the
// six charter businesses / seven pinned account assignments (or be null).
// The first D078 bundle was rejected because five tails/censuses were
// fleet-wide while claiming six-business scope; this guard fails on any
// recurrence, and also re-checks the recompute artifact rows.
//
// R2 — secret/residue: the rejected local-QA harness persisted a fixed raw
// session token and a concrete local connection string (and left a launch
// entry pointing at a deleted cluster). The needles below are built by
// concatenation so this guard itself never contains the forbidden strings.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BUNDLE_PATH = join(
  ROOT,
  "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json",
);
const RECOMPUTE_PATH = join(
  ROOT,
  "docs/audits/generated/d078-hard-action-recompute-2026-08-30.json",
);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function loadJson(path: string): { [k: string]: Json } {
  return JSON.parse(readFileSync(path, "utf8")) as { [k: string]: Json };
}

describe("D078 R1 — artifact scope guard", () => {
  it("the bundle's scoped sections carry only the seven pinned business→account PAIRS (C2.6)", () => {
    const bundle = loadJson(BUNDLE_PATH) as {
      scopeContract: {
        charterBusinessIds: string[];
        charterAccountIds: string[];
        charterAssignments: Record<string, string[]>;
      };
      payload: { [k: string]: Json };
    };
    const six = new Set(bundle.scopeContract.charterBusinessIds);
    const accounts = new Set(bundle.scopeContract.charterAccountIds);
    const assignments = bundle.scopeContract.charterAssignments;
    expect(six.size).toBe(6);
    expect(accounts.size).toBe(7);
    // The assignment map itself must be exactly the charter: six businesses,
    // seven unique accounts, no overlap, and its ids must equal the two
    // allowlists (a drifted list can no longer hide behind set membership).
    expect(Object.keys(assignments).sort()).toEqual(
      [...six].sort(),
    );
    const pairAccounts = Object.values(assignments).flat();
    expect(pairAccounts).toHaveLength(7);
    expect(new Set(pairAccounts).size).toBe(7);
    expect([...pairAccounts].sort()).toEqual([...accounts].sort());

    const violations: string[] = [];
    const walk = (node: Json, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (node && typeof node === "object") {
        const record = node as { [k: string]: Json };
        let rowBusiness: string | null = null;
        let rowAccount: string | null = null;
        for (const [key, value] of Object.entries(record)) {
          if (typeof value === "string" && value) {
            if (/business(_ref)?_id/i.test(key)) {
              rowBusiness = value;
              if (!six.has(value)) violations.push(`${path}.${key}=${value}`);
            }
            if (/provider_account_id/i.test(key)) {
              rowAccount = value;
              if (!accounts.has(value))
                violations.push(`${path}.${key}=${value}`);
            }
          } else if (value && typeof value === "object") {
            walk(value, `${path}.${key}`);
          }
        }
        // Pair rule: a row naming BOTH must be one of the seven pinned
        // assignments exactly — a charter account under the wrong charter
        // business is a violation even though both ids pass set membership.
        if (
          rowBusiness &&
          rowAccount &&
          !(assignments[rowBusiness] ?? []).includes(rowAccount)
        ) {
          violations.push(`${path} pair=${rowBusiness}/${rowAccount}`);
        }
      }
    };
    for (const [section, value] of Object.entries(bundle.payload)) {
      if (section === "fleetGlobal") continue; // explicitly-labelled fleet facts
      walk(value, `payload.${section}`);
    }
    expect(violations).toEqual([]);

    // The in-bundle production probe of the shipped read must hold exactly
    // the seven pairs (one row each).
    const probe = (bundle.payload as {
      assignedAccountStatesProbe: Array<{
        business_id: string;
        provider_account_id: string;
      }>;
    }).assignedAccountStatesProbe;
    expect(probe).toHaveLength(7);
    const probePairs = probe
      .map((row) => `${row.business_id}/${row.provider_account_id}`)
      .sort();
    const charterPairs = Object.entries(assignments)
      .flatMap(([business, ids]) => ids.map((id) => `${business}/${id}`))
      .sort();
    expect(probePairs).toEqual(charterPairs);
  });

  it("fleetGlobal exists, is labelled, and names no business ids at all", () => {
    const bundle = loadJson(BUNDLE_PATH) as {
      payload: { fleetGlobal: { [k: string]: Json } };
    };
    const fleet = bundle.payload.fleetGlobal;
    expect(typeof fleet.scopeNote).toBe("string");
    // Fleet facts must not leak per-business identities either — they are
    // structural (table size, worker heartbeat, denominators).
    const raw = JSON.stringify(fleet);
    expect(raw).not.toMatch(/"(last_)?business(_ref)?_id"\s*:\s*"[0-9a-f-]{36}"/i);
  });

  it("the recompute artifact rows carry only charter ids", () => {
    const bundle = loadJson(BUNDLE_PATH) as {
      scopeContract: { charterBusinessIds: string[]; charterAccountIds: string[] };
    };
    const six = new Set(bundle.scopeContract.charterBusinessIds);
    const accounts = new Set(bundle.scopeContract.charterAccountIds);
    const recompute = loadJson(RECOMPUTE_PATH) as {
      sourceBundleHash: string;
      rows: Array<{ businessId: string; providerAccountId: string }>;
    };
    const assignments = (loadJson(BUNDLE_PATH) as {
      scopeContract: { charterAssignments: Record<string, string[]> };
    }).scopeContract.charterAssignments;
    for (const row of recompute.rows) {
      expect(six.has(row.businessId)).toBe(true);
      expect(accounts.has(row.providerAccountId)).toBe(true);
      // Exact pair membership (C2.6).
      expect(
        (assignments[row.businessId] ?? []).includes(row.providerAccountId),
        `${row.businessId}/${row.providerAccountId}`,
      ).toBe(true);
    }
  });

  it("the recompute artifact is bound to the current bundle's payload hash", () => {
    const bundle = loadJson(BUNDLE_PATH) as { bundleHash: string };
    const recompute = loadJson(RECOMPUTE_PATH) as { sourceBundleHash: string };
    expect(recompute.sourceBundleHash).toBe(bundle.bundleHash);
  });
});

// C3.4: the guard walked `payload` and `scopeContract` but never pinned the
// TOP-LEVEL `bundle.businesses` list itself — an extra, missing, duplicated
// or renamed business row there would have passed. Pure helper so the
// fail-first cases are deterministic.
const D078_CHARTER_BUSINESS_NAMES: Record<string, string> = {
  "f8a3b5ac-588c-462f-8702-11cd24ff3cd2": "IwaStore",
  "5dbc7147-f051-4681-a4d6-20617170074f": "Grandmix",
  "6c690fa4-6395-40b5-9755-e99b34d69bc3": "Bilsem Zeka",
  "172d0ab8-495b-4679-a4c6-ffa404c389d3": "TheSwaf",
  "b79683b4-6f87-48c0-a3ca-44d4356fef51": "IwaTR",
  "bc0c6178-7853-4f6f-b026-ef0222a4b9e7": "ColorFullWorldsTR",
};

function topLevelBusinessFailures(
  businesses: Array<{ businessId: string; name: string }>,
  charterBusinessIds: string[],
): string[] {
  const failures: string[] = [];
  if (businesses.length !== 6)
    failures.push(`expected exactly 6 top-level businesses, found ${businesses.length}`);
  const ids = businesses.map((row) => row.businessId);
  if (new Set(ids).size !== ids.length)
    failures.push("duplicate top-level business id");
  if ([...ids].sort().join("|") !== [...charterBusinessIds].sort().join("|"))
    failures.push("top-level business ids do not equal scopeContract.charterBusinessIds");
  for (const row of businesses) {
    const pinned = D078_CHARTER_BUSINESS_NAMES[row.businessId];
    if (!pinned) failures.push(`non-charter top-level business id ${row.businessId}`);
    else if (row.name !== pinned)
      failures.push(`business ${row.businessId} named "${row.name}", charter pins "${pinned}"`);
  }
  return failures;
}

describe("D078 C3.4 — top-level six-business list is pinned too", () => {
  it("bundle.businesses is exactly the six unique charter ids with the pinned charter names", () => {
    const bundle = loadJson(BUNDLE_PATH) as unknown as {
      businesses: Array<{ businessId: string; name: string }>;
      scopeContract: { charterBusinessIds: string[] };
    };
    expect(
      topLevelBusinessFailures(
        bundle.businesses,
        bundle.scopeContract.charterBusinessIds,
      ),
    ).toEqual([]);
  });

  it("fail-first: an extra, missing, duplicate, or renamed top-level business each fails", () => {
    const bundle = loadJson(BUNDLE_PATH) as unknown as {
      businesses: Array<{ businessId: string; name: string }>;
      scopeContract: { charterBusinessIds: string[] };
    };
    const charter = bundle.scopeContract.charterBusinessIds;
    const base = () =>
      bundle.businesses.map((row) => ({ ...row }));

    const extra = base();
    extra.push({ businessId: "00000000-0000-4000-8000-000000000000", name: "Intruder" });
    expect(topLevelBusinessFailures(extra, charter)).not.toEqual([]);

    const missing = base();
    missing.pop();
    expect(topLevelBusinessFailures(missing, charter)).not.toEqual([]);

    const duplicated = base();
    duplicated[5] = { ...duplicated[0]! };
    expect(topLevelBusinessFailures(duplicated, charter)).not.toEqual([]);

    const renamed = base();
    renamed[0]!.name = "IwaStore Renamed";
    expect(topLevelBusinessFailures(renamed, charter)).not.toEqual([]);
  });
});

describe("D078 C3.2.7/C3.3.4 — static wiring guards on the proof files themselves", () => {
  // Needles by concatenation so this guard never matches itself.
  const MOCK_PREFIX = "vi.m" + "ock(";
  const ACCESS_MOCK = MOCK_PREFIX + '"@/lib/' + 'access"';
  const POSTURE_MOCK = MOCK_PREFIX + '"@/lib/meta/' + 'business-data-posture"';
  const SESSIONS_UPDATE = new RegExp("UPDATE\\s+" + "sessions", "i");
  const ACTIVE_BUSINESS_SET = new RegExp(
    "active_business" + "_id\\s*=\\s*\\$",
  );

  it("the actual-route CTA proof mocks ONLY the provider-inventory boundary (no access/posture mocks — the rejected correction-2 shape)", () => {
    const file = join(
      ROOT,
      "app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx",
    );
    const content = readFileSync(file, "utf8");
    expect(content.includes(ACCESS_MOCK)).toBe(false);
    expect(content.includes(POSTURE_MOCK)).toBe(false);
    // The one declared boundary must still be there — this guard must not
    // pass by the file ceasing to exist as a proof.
    expect(content.includes(MOCK_PREFIX + '"@/lib/' + 'api/meta"')).toBe(true);
  });

  it("the drawer proof mocks no data/provider boundary at all", () => {
    const file = join(
      ROOT,
      "app/api/meta/decisions-workspace/drawer-cta.db.test.tsx",
    );
    const content = readFileSync(file, "utf8");
    expect(content.includes(ACCESS_MOCK)).toBe(false);
    expect(content.includes(POSTURE_MOCK)).toBe(false);
    expect(content.includes(MOCK_PREFIX + '"@/lib/' + 'api/meta"')).toBe(false);
  });

  it("the browser harness performs no sessions mutation after the single seed (C3.3.4)", () => {
    const harnessPath = join(
      ROOT,
      "scripts/audits/d078-local-ui-ephemeral-harness.ts",
    );
    const content = readFileSync(harnessPath, "utf8");
    // The one seeded initial state lives in the seed module; the harness
    // itself may neither UPDATE the sessions table nor set
    // active_business_id — hops must be real switcher interactions.
    expect(SESSIONS_UPDATE.test(content)).toBe(false);
    expect(ACTIVE_BUSINESS_SET.test(content)).toBe(false);
    // And the seed module carries exactly ONE sessions INSERT (the initial
    // state) and no sessions UPDATE.
    const seed = readFileSync(
      join(ROOT, "scripts/audits/d078-lattice-seed.ts"),
      "utf8",
    );
    expect(SESSIONS_UPDATE.test(seed)).toBe(false);
    const inserts = seed.match(
      new RegExp("INSERT\\s+INTO\\s+" + "sessions", "gi"),
    );
    expect(inserts).toHaveLength(1);
  });
});

describe("D078 C2.4 — account-state evidence never feeds a write selector", () => {
  // The deselected/historical evidence contract is read-only by design. No
  // provider-write surface may consume it as an account scope: if any of
  // these modules ever references the evidence identifiers, that is a new
  // write-scope decision requiring its own ADR, not a refactor.
  const WRITE_SURFACES = [
    "lib/meta/ads-write.ts",
    "lib/meta/ads-action-routes.ts",
    "lib/meta/entity-action-routes.ts",
    "lib/meta/launch-write.ts",
    "lib/meta/launchpad-handoff-server.ts",
    "lib/meta/automation-control-plane.ts",
    "app/api/meta/ads",
    "app/api/meta/adsets",
    "app/api/meta/campaigns",
    "app/api/launchpad/meta",
    "app/api/meta/automation",
  ];
  const EVIDENCE_IDENTIFIERS =
    /assignedAccountStates|historicalAccounts|readMetaAssignedAccountStates|deselected_historical/;

  function collect(target: string, out: string[] = []): string[] {
    const full = join(ROOT, target);
    if (!existsSync(full)) return out;
    const stats = statSync(full);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(full))
        collect(join(target, entry), out);
    } else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) {
      out.push(full);
    }
    return out;
  }

  it("no write surface references the read-only account-state evidence", () => {
    const offenders: string[] = [];
    for (const target of WRITE_SURFACES) {
      for (const file of collect(target)) {
        if (EVIDENCE_IDENTIFIERS.test(readFileSync(file, "utf8"))) {
          offenders.push(file.replace(`${ROOT}/`, ""));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("D078 R2 — secret/residue guard", () => {
  // Needles assembled so this file itself can never match a residue scan.
  const OLD_TOKEN = ["d078-local", "qa-token"].join("-");
  const OLD_DSN =
    "postgresql://postgres@" + "127.0.0.1:15544/" + "adsecute_d078_local";
  const OLD_LAUNCH_ENTRY = ["d078-local", "ephemeral"].join("-");

  function filesUnder(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) filesUnder(full, out);
      else if (/\.(ts|tsx|json|md)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const SCAN_TARGETS = [
    join(ROOT, ".claude/launch.json"),
    ...filesUnder(join(ROOT, "scripts/audits")),
    ...filesUnder(join(ROOT, "docs/audits")),
  ];

  it("no D078 artifact, script, or launch config carries the old token, DSN, or launch entry", () => {
    const offenders: string[] = [];
    for (const file of SCAN_TARGETS) {
      const content = readFileSync(file, "utf8");
      for (const needle of [OLD_TOKEN, OLD_DSN, OLD_LAUNCH_ENTRY]) {
        if (content.includes(needle)) {
          offenders.push(`${file.replace(`${ROOT}/`, "")} :: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no D078 script prints or persists a concrete session cookie value or DSN", () => {
    const harness = join(
      ROOT,
      "scripts/audits/d078-local-ui-ephemeral-harness.ts",
    );
    if (!existsSync(harness)) return; // removed entirely is also compliant
    const content = readFileSync(harness, "utf8");
    // The raw token may exist only in process memory: no literal token
    // constant, no console output of cookie/DSN values.
    expect(content).not.toMatch(/console\.(log|error)\([^)]*omniads_session=/);
    expect(content).not.toMatch(/console\.(log|error)\([^)]*DATABASE_URL=\$\{/);
    expect(content).not.toMatch(/QA_SESSION_TOKEN\s*=\s*["'][^"']+["']/);
  });
});
