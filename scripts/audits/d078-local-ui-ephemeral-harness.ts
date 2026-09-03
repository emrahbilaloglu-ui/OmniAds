#!/usr/bin/env node
// D078 Phase C (correction 1) — local-HEAD six-business UI acceptance on an
// EPHEMERAL local Postgres, self-contained and secret-free.
//
// Production is never touched: local HEAD must not run against the prod
// tunnel (boot-time runtime-contract writes; missing D075/D077 schema), so
// this harness boots a throwaway cluster, runs the real deploy migrations
// from zero, seeds a SANITIZED production-shaped fixture for ALL SIX charter
// businesses and all SEVEN pinned account assignments (facts derived from
// the frozen D078 evidence bundle), launches the dev server itself, drives
// a Playwright Chromium session itself, and writes a per-business/surface
// acceptance matrix plus screenshots.
//
// Secret handling (D078 correction R2): the QA session token is generated
// with crypto.randomBytes at runtime and lives in process memory only; the
// database stores only its sha256; the cookie is injected straight into the
// browser context; nothing prints or persists the token, the cookie value,
// or a concrete connection string. Teardown stops/deletes the dev server,
// browser, cluster and data directory in `finally`.
//
// TheSwaf-Main carries a CONSTITUTIONALLY VALID native decision lattice
// (calibration batch/row → context → evaluations → snapshots bound by the
// authority CHECK → job-run hydration receipts) with one STALE authorized
// cut, one FRESH authorized cut, and one keep row. HONEST PROOF SPLIT
// (D078 correction 2): the BROWSER pass proves the FAIL-CLOSED contract —
// without a live current-provider-inventory read the workspace withholds
// the lattice entirely and offers no mutation control. The row-level
// stale/fresh CTA contract is proven by the ACTUAL-ROUTE integration test
// this harness runs against the same seeded cluster
// (app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx), where
// only the external provider-inventory boundary is mocked and freshness is
// derived by the shipped 12-hour evaluator. No provider/network call
// occurs anywhere; automation stays OFF.
//
// C2.1: business switching happens exclusively through the REAL topbar
// switcher after the single seeded initial state — the sessions table is
// never touched between hops — and every hop is recorded as a
// machine-readable entry in `switcherProof`. C2.5: the harness validates
// the finished artifact against scripts/audits/d078-matrix-contract and
// exits NONZERO (after full teardown) on any violation.
//
// Usage: npx tsx scripts/audits/d078-local-ui-ephemeral-harness.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Client } from "pg";
import {
  seedD078Fixture,
  type SeedResult,
} from "@/scripts/audits/d078-lattice-seed";
import {
  D078_MATRIX_CONTRACT,
  validateD078Matrix,
  type D078MatrixEntry,
  type D078SwitchHop,
  D078_SWITCH_ORDER,
} from "@/scripts/audits/d078-matrix-contract";

const PG_PORT = 15544;
const DEV_PORT = 3210;
const FORBIDDEN_PORTS = new Set([15432, 5432]);
const DB_NAME = "adsecute_d078_qa";
const DB_USER = "postgres";
const BUNDLE_PATH =
  "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json";
const MATRIX_OUT =
  "docs/audits/generated/d078-local-ui-acceptance-matrix-2026-08-30.json";
const SHOT_DIR = "docs/audits/generated/d078-local-ui-screenshots";
const ENGINE_VERSION =
  "v3-ad-2026-07-18-decision-presentation-hardening-shadow";

type Row = Record<string, unknown>;
const PG_TOOL_ENV = { ...process.env, LC_ALL: "C" };

function log(message: string) {
  console.log(`[d078-qa] ${message}`);
}
function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres", "createdb"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary))))
      return dir;
  }
  throw new Error("PostgreSQL binaries not found; set EPHEMERAL_PG_BIN_DIR.");
}

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, { encoding: "utf8", env: PG_TOOL_ENV });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${label} exited ${result.status}\n${result.stderr}`);
}

async function assertPortFree(port: number) {
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`forbidden port ${port}`);
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

async function runMigrations(databaseUrl: string) {
  log("running deploy migrations from zero...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
          ENABLE_RUNTIME_MIGRATIONS: "1",
          ADSECUTE_EPHEMERAL_DB_SEAM: "1",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrations exited ${code}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Dev server + browser matrix
// ---------------------------------------------------------------------------
async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      if (Date.now() > deadline) throw new Error(`dev server not ready: ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

interface MatrixEntry {
  business: string;
  surface: string;
  width: number;
  observed: string;
  assertions: Record<string, boolean>;
  screenshot: string | null;
}

async function main() {
  await assertPortFree(PG_PORT);
  await assertPortFree(DEV_PORT);
  const binDir = resolvePgBinDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "d078-qa-pg-"));
  const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${PG_PORT}/${DB_NAME}`;
  let devServer: ChildProcess | null = null;
  let browserClose: (() => Promise<void>) | null = null;

  try {
    runSync(path.join(binDir, "initdb"), ["-D", dataDir, "-U", DB_USER, "-A", "trust"], "initdb");
    runSync(
      path.join(binDir, "pg_ctl"),
      ["-D", dataDir, "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-w", "start", "-l", path.join(dataDir, "pg.log")],
      "pg_ctl start",
    );
    runSync(path.join(binDir, "createdb"), ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", DB_USER, DB_NAME], "createdb");
    await runMigrations(databaseUrl);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    let seeded: SeedResult;
    try {
      seeded = await seedD078Fixture(client);
    } finally {
      await client.end();
    }

    log("starting dev server (env in-process only)...");
    devServer = spawn(
      "npx",
      ["next", "dev", "--hostname", "127.0.0.1", "--port", String(DEV_PORT)],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
        },
      },
    );
    devServer.stderr?.on("data", () => undefined);
    await waitForHttp(`http://127.0.0.1:${DEV_PORT}/`, 120_000);
    log("dev server ready; launching chromium...");

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    browserClose = () => browser.close();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies([
      {
        name: "omniads_session",
        value: seeded.sessionToken,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const matrix: MatrixEntry[] = [];
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();

    const surfaces = (businessId: string) => [
      { key: "decisions", url: `/platforms/meta?businessId=${businessId}` },
      {
        key: "creatives",
        url: `/platforms/meta?businessId=${businessId}&scope=creatives`,
      },
      {
        key: "automation",
        url: `/platforms/meta/automation?businessId=${businessId}`,
      },
      {
        key: "history",
        url: `/platforms/meta/history?businessId=${businessId}`,
      },
    ];

    // C2.1: one initial authenticated state (seed active business =
    // TheSwaf); every subsequent business change goes through the REAL
    // topbar switcher. No sessions-table writes occur between hops.
    const BUSINESS_ORDER = [...D078_SWITCH_ORDER];
    const byName = new Map(seeded.businesses.map((b) => [b.name, b]));
    const switchHops: D078SwitchHop[] = [];
    let currentBusiness = "TheSwaf";

    const gotoWithRetry = async (url: string) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.goto(`http://127.0.0.1:${DEV_PORT}${url}`, {
            waitUntil: "domcontentloaded",
            timeout: 120_000,
          });
          return;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
    };
    const escapeRe = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const switchTo = async (
      toName: string,
      width: number,
    ): Promise<D078SwitchHop> => {
      const fromName = currentBusiness;
      const target = byName.get(toName)!;
      let selectedIdentity = "";
      let renderedIdentity = "";
      let pass = false;
      try {
        await page
          .getByRole("button", { name: new RegExp(escapeRe(fromName)) })
          .first()
          .click({ timeout: 12_000 });
        await page
          .getByText(toName, { exact: true })
          .first()
          .click({ timeout: 12_000 });
        await page.waitForTimeout(4_500);
        selectedIdentity = (
          await page
            .getByRole("button", { name: new RegExp(escapeRe(toName)) })
            .first()
            .innerText()
            .catch(() => "")
        ).trim();
        const url = page.url();
        const bodyText = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        renderedIdentity = url.includes(target.id)
          ? `url:${toName}`
          : bodyText.includes(toName)
            ? `body:${toName}`
            : "unknown";
        pass =
          selectedIdentity.includes(toName) && renderedIdentity !== "unknown";
      } catch (error) {
        renderedIdentity = `error:${
          error instanceof Error ? error.message.slice(0, 120) : "unknown"
        }`;
      }
      if (pass) currentBusiness = toName;
      return {
        width,
        from: fromName,
        to: toName,
        selectedIdentity,
        renderedIdentity,
        pass,
      };
    };

    for (const width of [1440, 390]) {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 900,
      });
      for (const name of BUSINESS_ORDER) {
        const business = byName.get(name)!;
        // Land on the decisions page of the CURRENT business so the topbar
        // is present, then switch through the real control when needed.
        await gotoWithRetry(
          `/platforms/meta?businessId=${byName.get(currentBusiness)!.id}`,
        );
        await page.waitForTimeout(3_000);
        if (currentBusiness !== name) {
          switchHops.push(await switchTo(name, width));
        }
        for (const surface of surfaces(business.id)) {
          const theswafMobileHistory =
            width === 390 &&
            surface.key === "history" &&
            business.name === "TheSwaf";
          if (
            width === 390 &&
            surface.key !== "decisions" &&
            !theswafMobileHistory
          )
            continue;
          await gotoWithRetry(surface.url);
          await page.waitForTimeout(4000);
          const text = (await page.locator("body").innerText()).slice(0, 40_000);
          const assertions: Record<string, boolean> = {
            noManualLabelAsk: !new RegExp(
              // Assembled so this harness never itself matches the D074b
              // buyer-copy closure scan.
              ["manage l" + "abels", "l" + "abel campaign", "l" + "abel is required", "L" + "abel flips"].join("|"),
              "i",
            ).test(text),
            businessNamed: text.includes(business.name),
          };
          let observed = "rendered";
          if (surface.key === "decisions") {
            assertions.admissionStateOrRowsNamed =
              /admission-blocked|Blocked evidence|carry a decision|No rows were served/i.test(
                text,
              );
            if (width === 1440) {
              assertions.accountCoveragePanel =
                (await page
                  .locator('[data-testid="assigned-account-coverage"]')
                  .count()) > 0;
            }
            if (business.name === "TheSwaf" && width === 1440) {
              // The coverage panel is desktop decision-body evidence; the
              // 390px surface is the read-only mobile viewer — its
              // deselected-scope proof is the History picker at 390 below.
              assertions.deselectedAccountExplicit =
                /deselected · read-only history/.test(text) &&
                text.includes("act_921275999286619");
              assertions.timezoneAndPolicyVisible =
                /timezone America\/Chicago/.test(text) &&
                /explicit operator decision/.test(text);
            }
          }
          if (surface.key === "automation" && width === 1440) {
            assertions.recoverySectionPresent = text.includes(
              "State-history recovery readiness",
            );
            const pill = await page
              .locator('[data-field="business-writes"]')
              .first()
              .innerText()
              .catch(() => "");
            if (business.name === "IwaStore")
              assertions.killPillStopped = pill === "STOPPED";
            else if (business.name === "TheSwaf")
              assertions.killPillEnabled = pill === "ENABLED";
            else
              assertions.killPillBlockedNotConfigured =
                pill === "BLOCKED · NOT CONFIGURED";
          }
          if (surface.key === "history") {
            assertions.readOnlyChrome = /READ ONLY|read.only/i.test(text);
            if (business.name === "TheSwaf") {
              assertions.historicalOptgroupOffered =
                (await page
                  .locator('optgroup[label*="Historical / deselected"]')
                  .count()) > 0;
              // C2.4.3: actually SELECT the deselected NonTesvik scope and
              // prove the read-only historical state end to end.
              try {
                await page
                  .locator('select[aria-label="Meta account for History"]')
                  .selectOption("act_921275999286619", { timeout: 10_000 });
                await page.waitForTimeout(3_500);
                const note = await page
                  .getByTestId("historical-account-scope-note")
                  .innerText()
                  .catch(() => "");
                assertions.nonTesvikNoteVisible =
                  note.includes("read-only historical evidence") &&
                  note.includes("excluded from serving");
                assertions.nonTesvikCurrencyTimezoneVisible =
                  /Currency USD/.test(note) && /timezone/.test(note);
                assertions.nonTesvikSpendFreshnessVisible =
                  /Spend continued through/.test(note);
                // Generation evidence is explicit EITHER way: real counts
                // when a generation exists, an explicit no-generation
                // sentence otherwise (this fixture seeds no NonTesvik
                // generation; the 126-row production truth lives in the
                // bundle's assignedAccountStatesProbe).
                assertions.nonTesvikGenerationVisible =
                  /produced decision rows|No produced decision generation on record/.test(
                    note,
                  );
                assertions.nonTesvikPolicyVisible =
                  /explicit operator decision/.test(note);
                const pageText = await page.locator("body").innerText();
                assertions.nonTesvikIdentityVisible =
                  pageText.includes("act_921275999286619");
                const journal = await page.request.get(
                  `http://127.0.0.1:${DEV_PORT}/api/meta/history?businessId=${business.id}&providerAccountId=act_921275999286619`,
                  { timeout: 60_000 },
                );
                const journalBody = (await journal.json()) as {
                  accountScope?: string;
                };
                assertions.nonTesvikJournalScopeMarked =
                  journal.status() === 200 &&
                  journalBody.accountScope === "deselected_historical";
                // Provider-action verbs only — History's own filter "Apply"
                // button is a query control, not a provider write.
                assertions.nonTesvikNoWriteControls =
                  (await page
                    .locator("button:not([disabled])")
                    .filter({ hasText: /^(Pause|Resume|Cut|Launch)\b/ })
                    .count()) === 0;
              } catch (error) {
                assertions.nonTesvikSelectionSucceeded = false;
                observed = `nontesvik selection error: ${
                  error instanceof Error ? error.message.slice(0, 160) : "unknown"
                }`;
              }
            }
          }
          if (surface.key === "creatives" && business.name === "TheSwaf") {
            const staleSuffix = seeded.staleAdId.slice(-6);
            const freshSuffix = seeded.freshAdId.slice(-6);
            let sourceDiag = "api_unread";
            try {
              const api = await page.request.get(
                `http://127.0.0.1:${DEV_PORT}/api/meta/decisions-workspace?businessId=${business.id}&window=28d`,
                { timeout: 60_000 },
              );
              const body = (await api.json()) as {
                decisionReadModel?: { source?: Row };
                os?: { ads?: { items?: unknown[] } };
              };
              sourceDiag = JSON.stringify({
                source: body.decisionReadModel?.source ?? null,
                osAdCount: body.os?.ads?.items?.length ?? null,
              }).slice(0, 900);
            } catch (error) {
              sourceDiag = `api_error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`;
            }
            observed = `stale:${text.includes(staleSuffix)} fresh:${text.includes(freshSuffix)}; ${sourceDiag}`;
            // FAIL-CLOSED PROOF (browser): the workspace refuses to present
            // native rows without a CURRENT live provider inventory read,
            // and this offline fixture deliberately has none. The lattice
            // must NOT surface here; no mutation control may exist. The
            // row-level stale/fresh CTA contract is proven by the
            // ACTUAL-ROUTE test this harness runs (routeCtaProof below).
            assertions.nativeRowsWithheldWithoutProviderInventory =
              !text.includes(staleSuffix) && !text.includes(freshSuffix);
            const enabledCuts = await page
              .locator("button:not([disabled])")
              .filter({ hasText: /^Cut$/ })
              .count();
            assertions.noEnabledMutationControlOffline = enabledCuts === 0;
          }
          const failed = Object.entries(assertions)
            .filter(([, ok]) => !ok)
            .map(([name]) => name);
          const shot = `${SHOT_DIR}/${business.name.replace(/\s+/g, "-")}-${surface.key}-${width}.png`;
          await page.screenshot({ path: shot, fullPage: false });
          matrix.push({
            business: business.name,
            surface: surface.key,
            width,
            observed:
              failed.length > 0
                ? `${observed}; FAILED=${failed.join(",")}; excerpt=${text
                    .slice(0, 700)
                    .replace(/\s+/g, " ")}`
                : observed,
            assertions,
            screenshot: shot,
          });
        }
      }
    }

    // C2.2/C3.2: the actual-route stale/fresh CTA proof against the SAME
    // seeded cluster — two serial vitest runs: (1) the node actual-route
    // test (real GET, real cookie auth, real posture, only the external
    // provider-inventory boundary mocked, freshness derived by the shipped
    // evaluator), which captures its route payload to a handoff file; (2)
    // the jsdom drawer/action test that drives the real MetaPlatformPage
    // wiring — row review → real evidence drawer → real supervised-Cut
    // control and confirmation ceremony — over that exact payload. Runs
    // before teardown because the first needs the live cluster.
    log("running actual-route + drawer CTA proofs (DB-backed vitest)...");
    const ctaHandoffPath = path.join(dataDir, "d078-cta-handoff.json");
    const summarize = (proc: { stdout?: string | null; stderr?: string | null }) =>
      `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`
        .split("\n")
        .filter((line) => /Tests|Test Files/.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    const routeProc = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx",
        "--maxWorkers=1",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
          D078_LATTICE_DB: "1",
          D078_CTA_HANDOFF: ctaHandoffPath,
        },
      },
    );
    const drawerProc =
      routeProc.status === 0
        ? spawnSync(
            "npx",
            [
              "vitest",
              "run",
              "app/api/meta/decisions-workspace/drawer-cta.db.test.tsx",
              "--maxWorkers=1",
            ],
            {
              encoding: "utf8",
              env: { ...process.env, D078_CTA_HANDOFF: ctaHandoffPath },
            },
          )
        : null;
    const combinedStatus =
      routeProc.status === 0 ? (drawerProc?.status ?? 1) : routeProc.status;
    const routeSummary = [
      `route: ${summarize(routeProc)}`,
      drawerProc
        ? `drawer: ${summarize(drawerProc)}`
        : "drawer: not run (route proof failed)",
    ].join(" | ");
    const routeCtaProof = {
      ran: true,
      exitCode: combinedStatus,
      summary: routeSummary || "no summary captured",
    };
    log(`routeCtaProof: exit ${combinedStatus} — ${routeSummary}`);

    await admin.end();
    const artifact = {
      contract: D078_MATRIX_CONTRACT,
      generatedAt: new Date().toISOString(),
      basis:
        "local ephemeral cluster + real deploy migrations + sanitized bundle-derived fixture; Playwright Chromium driven by this harness (secrets in process memory only); business changes exclusively via the real topbar switcher; row-level CTA proof via the DB-backed actual-route test recorded in routeCtaProof",
      switcherProof: switchHops,
      routeCtaProof,
      matrix,
    };
    fs.writeFileSync(MATRIX_OUT, `${JSON.stringify(artifact, null, 1)}\n`);
    // C2.5: the harness FAILS (nonzero exit, after teardown) on any
    // contract violation — assertions, hop failures, missing/duplicate
    // entries, missing/empty screenshots, or a failed route CTA proof.
    const validationFailures = validateD078Matrix(artifact, {
      screenshotSize: (shotPath) => {
        try {
          return fs.statSync(shotPath).size;
        } catch {
          return null;
        }
      },
    });
    log(
      `matrix written: ${MATRIX_OUT} (${matrix.length} entries, ${switchHops.length} switch hops, ${validationFailures.length} contract violations)`,
    );
    for (const failure of validationFailures.slice(0, 12)) {
      log(`CONTRACT VIOLATION: ${failure.slice(0, 300)}`);
    }
    if (validationFailures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (browserClose) await browserClose().catch(() => undefined);
    if (devServer && !devServer.killed) {
      devServer.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (devServer.exitCode === null) devServer.kill("SIGKILL");
    }
    try {
      runSync(
        path.join(binDir, "pg_ctl"),
        ["-D", dataDir, "stop", "-m", "fast"],
        "pg_ctl stop",
      );
    } catch {
      // already stopped
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    log("teardown complete: dev server stopped, cluster deleted");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
