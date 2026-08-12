# Adsecute Zero-Base Design — V3 release changelog

Release authority: this package root + generated `export/v3/`. Rule version 3.1.0.
Active-manifest fingerprint (package SHA-256 over every active file, computed by data/audit.js):
`f27bf51b31ddffe20b5c6404f5b7c1758ba5087342cd84941bf6c2d937befe4a`
(The delivered ZIP has its own SHA-256, printed in the release note — the ZIP hash covers the
archive bytes; the fingerprint above covers the active files and is what audit.json binds to.)

## Root-blocker closure (V3 → V3.1 revision)

1. **One authoritative, reproducible release** — `export/v3/` now generated from the live
   modules and the audit run itself: audit.json, interaction-manifest.json, sitemap.json,
   instrumentation-ledger.json, report-catalog.json, reconciliation.json, artifact-index.json,
   CHANGELOG.md, ACCEPTANCE.md. `notes/v3-plan.md` moved to `v1/notes/` (archive). Artifact 00
   rewritten: one active authority, generated artifact index, labelled archives. Cold-load
   probe (vendor/probe.js) on all 24 pages: REQ-40 = 0 console/page/resource/external findings.
2. **Semantic/control/event equality** — REQ-05 = 0 unresolved of 277 (locators mandatory for
   every rule incl. frameless rules via doc locators; AUTO-11..14, META-HIST-07, GOOGLE-31,
   TEAM-07 rules added). REQ-06 = 0 of 24 (INV-02 repointed to H10, INV-14 to matrix M4 source).
   REQ-09: 142 rendered keys ≡ 142 contracts, unbound 0, unused 0 — live:CREATIVE-10 mint drawn
   (H27 state B), live:REPORT-03 keyboard-mode drawn (H38), base live:GOOGLE-30 and
   live:GOOGLE-ESC-01 removed (drawn variants remain). REQ-10: disabled:LAUNCH-06/07 events set
   to none; launch_disabled_viewed lives on the launchpad surface in the instrumentation ledger.
3. **Mutation suite rebuilt** — 23 isolated mutations (data/mutations.js), each on a fresh
   structured clone; detection requires a genuinely READY baseline (REQ-28 self-reference broken
   by an explicit, visible suite-internal assumption), the expected requirement passing at
   baseline, and a READY→NOT-READY flip naming that exact requirement.
4. **Accessibility certification** — REQ-16 measured per theme: 0 of 345 light, 0 of 7 dark
   (dark specimens measured inside the P08 artboard); oklch computed colors now parsed, so
   previously unmeasurable boundaries are measured. REQ-15 explicit role model: essential ≥13,
   secondary ≥12 (Fragment Mono is the declared secondary face), initials/glyph/mark declared
   via data-trole; every ≤2-character string explicitly classified (0 unclassified). Both
   observed text-contrast failures fixed (H09 stale chip → #6f4b00; artifact-02 DK specimen).
5. **B02 repaired and honestly gated** — rail constrained to the 640px host, nav has a real
   measured scroll range, identity footer visible against every clipping ancestor and
   hit-testable at its visible coordinates (REQ-20 tests clip intersection + elementFromPoint +
   scroll range; M10 flips it).
6. **H28 fabricated cap removed** — "top 20 per window" / "Load 17 more" deleted;
   h28-landing-pages reclassified backend-total-unknown with "backend cap not supplied".
   REQ-45: capped rows require verified route provenance (h33 → GOOGLE-25 "max 250", h36 →
   GEO-03 "capped at 50"); numeric cap claims banned inside backend-total-unknown disclosures
   (M14 flips it).
7. **Sitemap tuple equality** — 14-field tuple per leaf (id·label·url·legacy·ctx·role·
   availability·surface·event·trigger·properties·actor·success·failure) hashed and compared
   across module ≡ rendered 02 ≡ rendered 17 ≡ shipped sitemap.json ≡ shipped ledger (REQ-44;
   M15/M16 flip it on a single URL/event change with the leaf ID retained).
8. **Registry expanded to 46 computed requirements** — flows (REQ-33), matrices (REQ-34),
   glossary/localization/replay/legacy (REQ-35), print + public-share responsive (REQ-36),
   mobile completion (REQ-37), decision-fact provenance (REQ-38), money-sum proof (REQ-39),
   cold-load integrity (REQ-40), reconciliation export (REQ-41), adversarial-review
   completeness (REQ-42), zero user-validation claims (REQ-43), tuple equality (REQ-44),
   cap provenance (REQ-45), generated artifact index (REQ-46). No hard-coded target count:
   completion = every registry row PASS.
9. **Mobile Agency/scope flows completed** — new frames H63/H64 (open MOBILE-02 scope sheet at
   390 and 320, all 8 scope fields), H65 (Agency⇄Client switch: eligible, denied, loading,
   empty, error), H66 (Flow A return with preserved Desk search/scroll); one-tap Agency Desk
   return added to the H60/H61 drawers; 320 headers disclose the evidence window. All gated by
   REQ-37 anchors (M17–M19 flip them).

## Hygiene
- `AUTO-01A..14` replaced with the explicit 15-capability enumeration in data/routes.js (both
  rows); malformed-range scan covers every active artifact and data module (M23 flips it).
- TopBar buyer chrome: internal ledger diagnosis removed (region absent); NOTIF-01 rationale
  lives in artifact 17 §6.
- H38: per-source contracts, empty/error copy and keyboard/bounds notes moved into a labelled
  HANDOFF SPECIFICATION band outside the artboard boundary.
- Artifact 19 dark board is a measured 1200px artboard with dark non-text specimens; 09's five
  pointer-styled specimens labelled STATIC; verification vocabulary remains prototype-tested vs
  specified-for-implementation.
- Type floors swept (wireframes 05–08, artifacts 01/02/03/04/13); banned token count 0.

## Changed files (this revision)
00, 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 (all
.dc.html), Rail.dc.html, TopBar.dc.html, CtxBar.dc.html, data/{audit,collections,evidence,
flows(new),gates,interactions,lint,mutations,requirements,routes,sitemap}.js,
vendor/probe.js (new), export/v3/* (new, generated), v1/notes/v3-plan.md (archived copy).
Unchanged: data/{capabilities,invariants,instrumentation,report-sources,semantics}.js,
support.js, vendored runtime/fonts, v1/, export/v2/.

## History
- V3 (previous): first fail-closed engine, 32 requirements, 10 mutations — superseded.
- V2 / V1: preserved under export/v2/ and v1/ as labelled archives; never authoritative.
