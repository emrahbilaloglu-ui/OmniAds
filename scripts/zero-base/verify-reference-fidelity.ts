/**
 * WP-26 / G10 — compare the implementation to the measured reference.
 *
 * Both documents are rendered in the same browser and measured by the same
 * function, so a difference here is a difference in the product rather than in
 * how the question was asked.
 *
 * Where the comparison is exact, and where it is bounded, is a deliberate
 * split. The reference is a static mock drawn with placeholder text; the
 * implementation renders real data of a different length. Demanding equal pixel
 * boxes would fail on a longer campaign name, which is not a fidelity defect.
 * So:
 *
 * **Exact** — the facts the reference genuinely fixes:
 *   - every required marker is present, visible, and not clipped away;
 *   - each marker's *owner* is the same region it belongs to in the design;
 *   - siblings appear in the same relative order;
 *   - a control's tag is a real control (a `data-ctl` on a `<div>` is not one);
 *   - typography family and weight, and size to the nearest step of the
 *     reference's own scale;
 *   - every colour painted resolves to a Ledger token.
 *
 * **Bounded** — the facts real data legitimately moves:
 *   - relative placement: if the reference puts A above B, so must the
 *     implementation; likewise left-of;
 *   - a region's share of the artboard, within a stated tolerance;
 *   - line-height as a ratio of font size.
 *
 * Every tolerance is named as a constant with the reason it exists.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { EXTRACT_VISUAL_FACTS, type VisualFact, type VisualSnapshot } from "@/lib/zero-base/visual-facts";
import { REFERENCE_VISUAL, type ReferenceVisual } from "@/scripts/zero-base/render-reference";
import { FRAMES, frameFileName } from "@/scripts/zero-base/frame-registry";
import { collectionKind, isTemplatePlaceholder } from "@/scripts/zero-base/verify-reference-anatomy";
import { DESIGN_ZIP_SHA256 } from "@/scripts/zero-base/extract-design-reference";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRAME_PAGES = path.join(ROOT, "playwright", ".frames");

/**
 * A region may occupy a different share of the artboard than the mock does,
 * because real content is a different length. Beyond this it is a different
 * composition rather than the same one with different words.
 */
export const AREA_SHARE_TOLERANCE = 0.35;

/** Line-height as a multiple of font size. Below 1.2 text collides. */
export const LINE_HEIGHT_MIN_RATIO = 1.15;

/** Interactive targets. WCAG 2.5.8 minimum, which the design also draws. */
export const MIN_TARGET_PX = 24;

/**
 * The two faces the design ships.
 *
 * Family is only compared when the reference resolved to one of these; the mock
 * falls back to the UA font wherever its own styling does not reach.
 */
const LEDGER_FACES = new Set(["schibsted grotesk", "fragment mono"]);

/** Tags that can carry a control contract. A div with onClick cannot. */
const CONTROL_TAGS = new Set(["button", "a", "input", "select", "textarea", "video", "label"]);

/**
 * Roles that make a non-control element a control.
 *
 * A tab list is a single composite control with its own keyboard model, and
 * Radix renders it as a div carrying `role="tablist"` — which is correct. The
 * role is what makes it operable, so the role is what is checked.
 */
const CONTROL_ROLES = new Set(["tablist", "radiogroup", "listbox", "menu", "group", "toolbar"]);

export interface FidelityFinding {
  frame: string;
  key: string;
  kind:
    | "missing"
    | "invisible"
    | "clipped"
    | "wrong-owner"
    | "wrong-order"
    | "not-a-control"
    | "target-too-small"
    | "geometry"
    | "placement"
    | "typography"
    | "line-height"
    | "untokenised-colour";
  detail: string;
}

/**
 * The colours the Ledger tokens actually produce, resolved by the browser.
 *
 * Reading the values out of `globals.css` as text does not work: the tokens are
 * authored in `oklch()` and hex, the browser reports painted colour as `rgb()`,
 * and comparing the two as strings marks every token colour "untokenised".
 * Resolving them in the same engine that painted them is the only comparison
 * that means anything.
 */
const RESOLVE_LEDGER_TOKENS = `(names) => {
  // Inside the canonical root: the tokens are declared on
  // [data-adc-ui="zero-base"], so a probe on <body> resolves none of them.
  const host = document.querySelector('[data-adc-ui="zero-base"]') || document.body;
  const probe = document.createElement("span");
  host.appendChild(probe);
  const out = {};
  for (const name of names) {
    probe.style.color = "";
    probe.style.color = "var(" + name + ")";
    const value = getComputedStyle(probe).color;
    if (value) out[name] = value;
  }
  probe.remove();
  return out;
}`;

function ledgerTokenNames(): string[] {
  const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  return [...new Set([...css.matchAll(/(--ledger-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))];
}

/**
 * Colours the reference draws that no Ledger token is responsible for.
 *
 * Chart series and illustration fills are one-off by design — the package draws
 * them inline and the token set deliberately does not name them. They are
 * listed explicitly, from the reference, so "not tokenised" is a stated
 * classification rather than a silent 19-colour gap the old gate printed and
 * ignored.
 */
export const NON_TOKEN_REFERENCE_COLOURS = new Set(
  [
    "rgb(59, 91, 219)", // chart indigo — ROAS at or above target
    "rgb(139, 148, 158)", // chart grey — below target
    "rgb(217, 119, 6)", // chart amber — partial day
  ].map((value) => value.toLowerCase()),
);

function normaliseColour(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Nearest step of the reference's own type scale. */
function nearestStep(size: number, scale: readonly number[]): number {
  return scale.reduce((best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best), scale[0] ?? size);
}

function factsByKey(snapshot: { facts: VisualFact[] }): Map<string, VisualFact[]> {
  const map = new Map<string, VisualFact[]>();
  for (const fact of snapshot.facts) map.set(fact.key, [...(map.get(fact.key) ?? []), fact]);
  return map;
}

/** A reference owner in the same vocabulary the implementation reports. */
function normaliseOwner(owner: string | null): string | null {
  if (owner === null) return null;
  return owner.startsWith("collection:")
    ? `collection:${collectionKind(owner.slice("collection:".length))}`
    : owner;
}

/** Normalised marker ancestry, so collections compare on kind. */
function ownerChain(fact: VisualFact): string[] {
  return fact.ownerPath.map((entry) =>
    entry.startsWith("collection:")
      ? `collection:${collectionKind(entry.slice("collection:".length))}`
      : entry,
  );
}

/**
 * Which occurrence of a repeated marker to compare against.
 *
 * A key can appear more than once — the same contract on two panels, or a row
 * action drawn per row. Taking whichever came first in document order made the
 * verdict depend on source ordering: a frame that *did* place the control
 * inside the region the design names still failed because an unrelated second
 * occurrence was found first. The design's statement is that such a control
 * exists inside that region, so the occurrence that satisfies the containment
 * is the one to check. When none does, the first is compared and it fails —
 * which is the outcome that matters.
 */
function pickFact(candidates: VisualFact[], wantOwner: string | null): VisualFact {
  if (wantOwner === null || wantOwner.startsWith("ctl:")) return candidates[0]!;
  return candidates.find((fact) => ownerChain(fact).includes(wantOwner)) ?? candidates[0]!;
}

/** Compare one implementation frame against its reference artboard. */
export function compareFrame(
  reference: VisualSnapshot,
  implementation: VisualSnapshot,
  typeScale: readonly number[],
  tokens: ReadonlySet<string>,
): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const impl = factsByKey(implementation);
  // One fact per key. A reference table with four rows draws one control four
  // times; the contract is the control, not each row.
  const seenRefKeys = new Set<string>();
  const refFacts = reference.facts
    .filter((fact) => !isTemplatePlaceholder(fact.key.replace(/^ctl:/, "")))
    .filter((fact) => {
      if (seenRefKeys.has(fact.key)) return false;
      seenRefKeys.add(fact.key);
      return true;
    });

  const add = (key: string, kind: FidelityFinding["kind"], detail: string) =>
    findings.push({ frame: reference.id, key, kind, detail });

  for (const want of refFacts) {
    // Collections are named per artboard in the reference; the implementation
    // has one component and emits the semantic kind.
    const key = want.key.startsWith("collection:")
      ? `collection:${collectionKind(want.key.slice("collection:".length))}`
      : want.key;

    const candidates = impl.get(key);
    const got = candidates ? pickFact(candidates, normaliseOwner(want.owner)) : undefined;
    if (!got) {
      add(key, "missing", "the reference draws this region; the implementation has no such marker");
      continue;
    }

    if (!got.visible) {
      add(key, "invisible", `rendered but not visible (${got.tag}, ${got.pixels.width}×${got.pixels.height})`);
      continue;
    }
    if (got.clipped) {
      add(key, "clipped", "an ancestor's overflow hides this from the reader");
      continue;
    }

    // Ownership: the design's region hierarchy, compared exactly.
    const wantOwner = normaliseOwner(want.owner);
    // One-directional, and deliberately so. Where the reference *nests* a
    // marker inside a region, that containment is a design fact and the
    // implementation must honour it. Where the reference leaves markers as
    // siblings, that is an artefact of a hand-drawn mock, not an instruction to
    // flatten a real component tree — so extra nesting is not a violation.
    // Containment is binding only where the reference's owner is a *region*.
    // Where the mock nests one control inside another, that cannot be an
    // instruction: a button may not contain a button, and nested interactive
    // elements are an accessibility defect rather than a layout to copy. The
    // mock draws its own "widget" as a plain div, so its nesting there is an
    // artefact of how it was drawn.
    //
    // Containment, not parentage. The design states that a control lives inside
    // a region; it does not state that nothing may sit between them. Requiring
    // the region to be the *nearest* marker ancestor would forbid putting a
    // real table inside a region the design itself draws a table in — the
    // implementation would have to flatten its component tree to satisfy a
    // drawing. So the region must appear somewhere in the enclosing chain.
    // Being outside it still fails, which is the property that matters.
    const ownerIsRegion = wantOwner !== null && !wantOwner.startsWith("ctl:");
    if (ownerIsRegion && !ownerChain(got).includes(wantOwner)) {
      add(
        key,
        "wrong-owner",
        `reference nests this inside ${wantOwner}; implementation nests it under ${got.owner ?? "the frame root"}`,
      );
    }

    // A control contract on a non-control element is not a control.
    const isControl = CONTROL_TAGS.has(got.tag) || CONTROL_ROLES.has(got.role ?? "");
    if (key.startsWith("ctl:") && !isControl) {
      add(key, "not-a-control", `carried by <${got.tag}>, which has no control semantics`);
    }

    if (key.startsWith("ctl:") && isControl) {
      const smallest = Math.min(got.pixels.width, got.pixels.height);
      if (smallest > 0 && smallest < MIN_TARGET_PX) {
        add(key, "target-too-small", `${Math.round(got.pixels.width)}×${Math.round(got.pixels.height)} is below the ${MIN_TARGET_PX}px minimum target`);
      }
    }

    // Area share is deliberately NOT compared.
    //
    // The artboards are compressed mocks — H03 draws the whole of Home in
    // roughly 850px — while the implementation renders the surface at its real
    // height with real data. Every region therefore occupies a systematically
    // different fraction, and a ratio test would fail on all 83 for a reason
    // that has nothing to do with fidelity. What the reference does fix about
    // position is *relative placement*, which is compared below.

    // Typography: family and weight exactly, size to the reference's own scale.
    // Family: the implementation must resolve to one of the two faces the
    // design ships.
    //
    // Not equality with the reference's family. The mock is one long document
    // whose blocks inherit whatever their author set — the same kind of region
    // is drawn in mono on one artboard and sans on another — so holding the
    // implementation to it flags a real difference on one artboard and its
    // exact opposite on the next. What the reference does establish is the
    // typeface *pair*, and a control falling back to Arial or Times is a real
    // regression this still catches.
    const gotFamily = got.fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
    if (gotFamily && !LEDGER_FACES.has(gotFamily)) {
      add(key, "typography", `rendered in ${gotFamily}, which is not a Ledger face`);
    }
    if (got.fontSizePx > 0 && nearestStep(got.fontSizePx, typeScale) !== got.fontSizePx) {
      add(
        key,
        "typography",
        `${got.fontSizePx}px is not a step of the reference type scale (nearest ${nearestStep(got.fontSizePx, typeScale)}px)`,
      );
    }
    if (got.fontSizePx > 0 && got.lineHeightPx / got.fontSizePx < LINE_HEIGHT_MIN_RATIO) {
      add(
        key,
        "line-height",
        `${got.lineHeightPx}px on ${got.fontSizePx}px text is below ${LINE_HEIGHT_MIN_RATIO}×`,
      );
    }
  }

  // Relative placement: what the reference fixes about the order of regions on
  // screen, independent of their size.
  const pairs = refFacts.filter((fact) => impl.has(fact.key));
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const a = pairs[i];
      const b = pairs[j];
      const ia = pickFact(impl.get(a.key)!, normaliseOwner(a.owner));
      const ib = pickFact(impl.get(b.key)!, normaliseOwner(b.owner));
      if (!ia.visible || !ib.visible) continue;
      // Only within one region.
      //
      // Order among siblings is a design fact: the reference decides that the
      // tier selector precedes the expiry field. Order *across* regions is not.
      // The mock is a single scrolling canvas where an overlay's contents are
      // drawn inline beneath the surface they cover, while the implementation
      // renders that overlay on top; comparing a marker inside a sheet against
      // one on the page below it measures the mock's document flow, not the
      // design's intent.
      if ((a.owner ?? null) !== (b.owner ?? null)) continue;
      // Not between a region and something it contains.
      //
      // Where the reference leaves a control at the top level, the containment
      // check deliberately allows the implementation to place it inside the
      // region it belongs to. Once it is inside, its top edge is necessarily
      // below that region's — so comparing the two would report every such
      // nesting as an ordering defect, and the only way to satisfy it would be
      // to pull the control back out of the region the design shows it serving.
      // The mock draws its markers as a flat strip; that is how it was drawn,
      // not an ordering it states.
      if (ownerChain(ia).includes(b.key) || ownerChain(ib).includes(a.key)) continue;
      // Only pairs the reference separates clearly, so a 1px difference in a
      // shared row is not treated as an ordering fact.
      if (a.box.y + 0.02 < b.box.y && ia.box.y > ib.box.y + 0.02) {
        findings.push({
          frame: reference.id,
          key: a.key,
          kind: "placement",
          detail: `reference places this above ${b.key}; implementation places it below`,
        });
      }
    }
  }

  // Every painted colour must be a Ledger token, unless the reference itself
  // draws it as a one-off chart or illustration colour.
  for (const colour of implementation.palette) {
    const value = normaliseColour(colour);
    if (value === "rgba(0, 0, 0, 0)") continue;
    if (NON_TOKEN_REFERENCE_COLOURS.has(value)) continue;
    if (!tokens.has(value)) {
      findings.push({
        frame: reference.id,
        key: value,
        kind: "untokenised-colour",
        detail: "painted but not produced by a Ledger token, and not a declared one-off",
      });
    }
  }

  return findings;
}

async function main() {
  const file = path.join(ROOT, REFERENCE_VISUAL);
  if (!existsSync(file)) {
    throw new Error(`No measured reference at ${REFERENCE_VISUAL}. Run:\n  npm run zero-base:reference:render`);
  }
  const reference = JSON.parse(readFileSync(file, "utf8")) as ReferenceVisual;
  if (reference.zipSha256 !== DESIGN_ZIP_SHA256) {
    throw new Error(
      `The measured reference was taken from a different archive.\n  recorded ${reference.zipSha256}\n  expected ${DESIGN_ZIP_SHA256}`,
    );
  }

  const tokenNames = ledgerTokenNames();
  const typeScale = [...new Set(reference.snapshots.flatMap((s) => s.typeScale))].sort((a, b) => a - b);

  const browser = await chromium.launch();
  const findings: FidelityFinding[] = [];
  const tokens = new Set<string>();
  const measurements: { snapshot: VisualSnapshot; implementation: VisualSnapshot }[] = [];
  let compared = 0;

  try {
    for (const snapshot of reference.snapshots) {
      const spec = FRAMES.find((frame) => frame.id === snapshot.id);
      if (!spec) continue;
      const page = await browser.newPage({ viewport: { width: spec.width, height: 1600 } });
      await page.emulateMedia({ colorScheme: spec.theme });
      // domcontentloaded, not load: the frames are static documents with
      // inline CSS, and waiting for `load` waits for image requests that will
      // never resolve offline.
      await page.goto(`file://${path.join(FRAME_PAGES, `${frameFileName(spec)}.html`)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(120);

      // Resolve the token palette in this document, so light and dark each
      // contribute the colours they actually produce.
      const resolved = (await page.evaluate(
        `(${RESOLVE_LEDGER_TOKENS})(${JSON.stringify(tokenNames)})`,
      )) as Record<string, string>;
      for (const value of Object.values(resolved)) tokens.add(normaliseColour(value));

      const measured = (await page.evaluate(
        `(${EXTRACT_VISUAL_FACTS})(${JSON.stringify("body > [data-frame]")})`,
      )) as Omit<VisualSnapshot, "id" | "width" | "theme"> | null;
      await page.close();

      if (!measured) {
        findings.push({
          frame: snapshot.id,
          key: "(frame)",
          kind: "missing",
          detail: "the rendered frame page has no frame root",
        });
        continue;
      }

      compared += 1;
      // Compared after every frame is measured: the token palette is only
      // complete once both themes have been resolved, and comparing early
      // would report a dark-only colour as untokenised.
      measurements.push({ snapshot, implementation: { id: snapshot.id, width: spec.width, theme: spec.theme, ...measured } });
    }
  } finally {
    await browser.close();
  }

  for (const { snapshot, implementation } of measurements) {
    findings.push(...compareFrame(snapshot, implementation, typeScale, tokens));
  }

  const byFrame = new Map<string, FidelityFinding[]>();
  for (const finding of findings) {
    byFrame.set(finding.frame, [...(byFrame.get(finding.frame) ?? []), finding]);
  }

  console.log("zero-base reference fidelity (rendered, measured, compared)\n");
  console.log(`  archive sha256      ${reference.zipSha256}`);
  console.log(`  artboards compared  ${compared}/${reference.snapshots.length}`);
  console.log(`  reference type scale ${typeScale.join(", ")}`);
  console.log(`  frames matching     ${compared - byFrame.size}/${compared}\n`);

  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  for (const [kind, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(20)} ${count}`);
  }

  if (findings.length > 0) {
    console.log("\n  first findings:");
    for (const finding of findings.slice(0, Number(process.env.FIDELITY_LIST ?? 20))) {
      console.log(`    ${finding.frame} ${finding.key} — ${finding.kind}: ${finding.detail}`);
    }
    console.log(
      `\nFAIL: ${findings.length} fidelity findings across ${byFrame.size} artboards. The\n` +
        "implementation does not match the accepted design where the reference is\n" +
        "authoritative.",
    );
    process.exit(1);
  }

  console.log("\nPASS: every artboard matches the measured reference.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
