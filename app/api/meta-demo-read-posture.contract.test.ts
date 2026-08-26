import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The READ-side sibling of `meta-demo-write-authority.contract.test.ts`.
 *
 * That test stops a Meta WRITE from being guarded by an instrument that reads a
 * database outage as "live". This one stops a Meta READ from being decided by
 * the same instrument — a defect that survived precisely because it looked
 * harmless: nothing is written, so nobody treated it as a boundary.
 *
 * It is one. `lib/business-mode.server.isDemoBusiness` swallows an unreadable
 * `businesses` table into `false`, and caches that guess for 60 seconds;
 * `lib/demo-business.isDemoBusinessId` never reads the column at all and is
 * only a comparison against one hard-coded id. A Meta read route holding either
 * one calls a provider, serves live figures as fact, and enables controls for a
 * workspace it cannot vouch for — while INVARIANTS is unconditional that a demo
 * workspace has zero Meta write authority and false action eligibility. A
 * screen that cannot tell must say so.
 *
 * ## Why structural
 *
 * The defect is the ABSENCE of a third branch, and no runtime test asserts a
 * branch it does not know to look for. Nine route files were found by reading
 * them one at a time. This is what stops the tenth: a NEW Meta route needs no
 * edit here to be covered, and a converted one that regresses fails even if
 * every behavioural test still passes.
 *
 * ## The two halves
 *
 * 1. No fail-open instrument is CALLED anywhere on the active Meta surface.
 * 2. Every caller of the tri-state read actually handles the third state.
 *    Reading `readMetaBusinessDataPosture` and then branching only on `demo`
 *    reintroduces the defect exactly — `unverified` would fall through to the
 *    live path, which is what the boolean did.
 *
 * What this cannot see is ORDER: that the refusal precedes the provider call is
 * a behavioural claim, asserted in the colocated route and source tests.
 */

/**
 * The ACTIVE Meta surface.
 *
 * Deliberately not the whole repository. `lib/archive/**` holds preserved V1/V2
 * bodies that are compatibility evidence rather than live code, and Google, SEO,
 * Klaviyo and Shopify have their own posture questions that are not this one.
 */
const SCANNED_ROOTS = [
  "app/api/meta",
  "app/api/launchpad/meta",
  "lib/meta",
  "lib/zero-base/meta",
];

/**
 * Instruments that answer "not a demo workspace" when they cannot tell.
 *
 * Matched as CALLS — `(?<![.\w])name\s*\(` — so a property of the same name
 * (`controlState.isDemoBusiness`, read from a real `is_demo_business` column)
 * is not mistaken for the fail-open function.
 */
const FAIL_OPEN_INSTRUMENTS = [
  {
    name: "isDemoBusiness",
    why: "swallows an unreadable businesses table into false and caches the guess for 60s (lib/business-mode.server.ts)",
  },
  {
    name: "isDemoBusinessId",
    why: "compares one hard-coded id and never reads businesses.is_demo_business (lib/demo-business.ts)",
  },
];

/** The canonical tri-state read every Meta read path must use instead. */
const POSTURE_READ = "readMetaBusinessDataPosture";

/**
 * How a caller may express "and this is not live".
 *
 * Any one of these is enough. What is NOT enough is branching on `demo` alone,
 * because the remaining path then serves an unverified workspace as live.
 */
const THIRD_STATE_MARKERS = [
  'metaPostureUnavailable',
  '=== "unverified"',
  '!== "live"',
  'posture !== "live"',
];

function listSourceFiles(dir: string): string[] {
  const root = path.join(process.cwd(), dir);
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Strip comments, so a name discussed in prose never counts as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Strip import statements too, for the third-state check only.
 *
 * Without this the check is satisfiable by an IMPORT of
 * `metaPostureUnavailable` that nothing calls — which is exactly the state a
 * half-finished conversion leaves behind, and exactly the state that must fail.
 */
function stripImports(source: string): string {
  return source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?$/gm, "");
}

function relative(file: string) {
  return path.relative(process.cwd(), file);
}

const FILES = SCANNED_ROOTS.flatMap(listSourceFiles);

describe("the active Meta surface reads posture fail-closed", () => {
  it("scans a non-empty surface, so a passing run means something", () => {
    // A broken path list would make every case below vacuously true.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("calls no instrument that reads an unreadable flag as live", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      // The posture module and this surface's own documentation NAME these
      // instruments in order to explain why they are not used. Prose is
      // stripped above; a call is not.
      const source = stripComments(fs.readFileSync(file, "utf8"));
      for (const instrument of FAIL_OPEN_INSTRUMENTS) {
        const call = new RegExp(`(?<![.\\w])${instrument.name}\\s*\\(`);
        if (call.test(source)) {
          offenders.push(`${relative(file)} calls ${instrument.name}() — ${instrument.why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("handles the third state wherever the tri-state read is used", () => {
    const callers = FILES.filter((file) =>
      new RegExp(`(?<![.\\w])${POSTURE_READ}\\s*\\(`).test(
        stripComments(fs.readFileSync(file, "utf8")),
      ),
    ).filter((file) => !file.endsWith(path.join("lib", "meta", "business-data-posture.ts")));

    // If nothing calls it, the surface has silently reverted to the boolean and
    // the case above would pass for the wrong reason.
    expect(callers.length).toBeGreaterThan(0);

    const fallThrough = callers.filter((file) => {
      const source = stripImports(stripComments(fs.readFileSync(file, "utf8")));
      return !THIRD_STATE_MARKERS.some((marker) => source.includes(marker));
    });
    expect(
      fallThrough.map(
        (file) =>
          `${relative(file)} reads the posture but branches only on "demo"; an unverified workspace falls through to the live path, which is the defect the tri-state exists to close`,
      ),
    ).toEqual([]);
  });
});
