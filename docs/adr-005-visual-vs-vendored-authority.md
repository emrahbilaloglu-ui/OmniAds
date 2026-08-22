# ADR-005 — Precedence between the visual source file and the vendored behavioural package

## Status

**Accepted** — 2026-08-22. Ratified under WP0 of
`docs/meta-market-ready-master-plan-2026-08-22.md`, which requires the precedence
rule to be written down (WP0 step 8) and lists it in §18 as "Visual vs vendored
authority → Visual dosya görünümü, vendored paket davranışı yönetir".

## Context

Two frozen artifacts both describe the product, and the plan's §3 ranks the
visual file first. Ranking alone is not a usable rule: taken literally, "the
visual file wins" would let a screenshot silently overrule an invariant that
exists to stop the product lying about data, and taken the other way, "the
package wins" would let a stale screen inventory overrule the design owner.

Concretely, the two disagree today:

| Question | Visual file (`2af6cbaf…`) | Vendored package (`docs/zero-base-design/v3`) |
|---|---|---|
| Is Audiences a Creative Studio tab? | Yes — fifth tab | No — merged into Intelligence (`generated-contracts.ts:716`) |
| May Launchpad execute? | Draws the controls | `disabled:LAUNCH-06/07` |

The first disagreement is about **what a screen is**. The second is about
**what a control may do**. They need opposite answers, which is why one blanket
precedence rule cannot serve both.

## Decision

**The visual file governs appearance. The vendored package governs behaviour.**

1. **The visual file wins on presentation**: which screens exist, which rail
   entries and tabs they have, layout, hierarchy, typography, colour, spacing,
   iconography, copy tone, and which controls appear on a surface. Its digest is
   `2af6cbaf5f366a7dee8fc0ae96fdf713eff777c62f16e2d57638368d1678637a`, pinned in
   `scripts/dashboard-v2/reference-contract.ts`.
2. **The vendored package wins on behaviour**: invariants, capabilities,
   refusal and disabled semantics, state machines, event contracts, and whether
   an action may reach a provider. A control the visual file draws is drawn; it
   is not thereby *enabled*.
3. **Drawn-but-not-permitted resolves to `disabled-with-reason`.** This is the
   rule that reconciles the two rows in the table above. The control appears
   exactly where the design puts it, with the design's styling, and it states
   why it will not run. It is neither hidden (which would contradict the visual
   authority) nor live (which would contradict the behavioural authority).
   ADR-003 applies this to LAUNCH-06/07.
4. **A dated inventory inside the package does not outrank a later design
   decision about what a screen is.** `mode: "merged"` for
   `/platforms/meta/audiences` is a screen-inventory fact from before Dashboard
   v2 restored the tab, so it loses to the visual file under rule 1. ADR-004
   applies this. This is narrow: it covers *which screens exist*, and never
   an invariant, a capability or a refusal.
5. **Neither artifact is hand-edited to resolve a conflict.** The visual file is
   re-hashed and re-pinned when the owner ships a new revision; the package is
   re-vendored, or the divergence is written into
   `docs/zero-base-design/v3/ACCEPTED_RESIDUALS.md`. Editing either to make a
   check pass is prohibited by the plan's §17.1–§17.2, and
   `scripts/zero-base/verify-design-contract.ts` continues to assert the
   package's own `NOT READY` verdict so a silent flip fails the build.
6. **Runtime beats both on questions of fact.** Neither artifact can establish
   what the deployed application does. Only the mounted production route can,
   which is the plan's §3 rank 4 and the reason `VERIFIED-RUNTIME` is a distinct
   evidence class from `VERIFIED-STATIC`.

## Consequences

- Every present conflict has a determinate answer without either file being
  modified, and the answer is derivable from the rule rather than negotiated
  per case.
- The most dangerous failure mode — a pretty screen quietly overruling a safety
  invariant — is closed by rule 2, while the design owner keeps full authority
  over what the product looks like.
- Residual divergences stay visible in `ACCEPTED_RESIDUALS.md` instead of being
  absorbed into code, so a re-vendor can close them.

## Rejected alternatives

- **Strict single ranking, visual over package, for everything.** Rejected: it
  would let a drawn control authorize a provider write, which §17.6 and §10
  forbid.
- **Strict single ranking, package over visual, for everything.** Rejected: it
  freezes the product at the package's screen inventory and makes the design
  owner's newer decisions unimplementable — the Audiences tab could never ship.
- **Case-by-case adjudication.** Rejected: that is the absence of a rule, and it
  reproduces the drift WP0 exists to end.
