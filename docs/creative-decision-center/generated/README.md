# Generated Artifact Provenance

This folder contains generated JSON artifacts for Creative Decision Center V2.1 planning and shadow validation.

These files are not production runtime behavior. They are context artifacts for future GPT/Codex/Claude chats and for migration planning.

## Files

- `aggregate-test.json`
- `before-after-shadow.json`
- `config-sensitivity.json`
- `data-readiness-coverage.json`
- `golden-cases.json`
- `live-status.json`
- `performance-smoke.json`

The following names are planned release outputs, not committed files:

- `native-ad-account-aov-authority-replay-<scheduler-date>-compact.json`
- `native-ad-account-aov-authority-replay-<scheduler-date>-compact.sha256`
- `native-ad-account-aov-authority-replay-<scheduler-date>-all-current-population-compact.json`
- `native-ad-account-aov-authority-replay-<scheduler-date>-all-current-population-compact.sha256`

These native-Ad compact artifacts are different from the older fixture-backed
spike files:

- the focused artifact proves the exact four requested physical Meta accounts;
- the all-current-population artifact proves every active, enabled,
  Meta-bound business/account in the same read-only snapshot.

When valid, both are bounded compact projections of a live
`REPEATABLE READ READ ONLY` v7 replay. They are not anonymous: exact
business/provider account identity is retained for coverage integrity, while
full per-Ad row drilldowns and customer-sensitive payloads stay outside the
repository under `/tmp`. Each compact artifact binds the omitted full artifact
by SHA-256/byte count and binds the repository content manifest captured before
output. Treat either artifact as valid only when its `releaseGate.passed` is
true, its provenance manifest still matches the repository, and its adjacent
`.sha256` file matches the committed bytes. Neither replay calls cron, writes
the database, contacts a provider, or grants automatic execution authority.

The 2026-07-19 focused and population attempts did not satisfy that contract.
They covered the exact 12-business/13-account scheduler population and all
14,771 challengers computed, but TheSwaf Main's hydration receipt declared zero
expected rows for 687 hydrated rows and was not authoritative for prune. The
resulting `releaseGate.passed=false` artifacts and placeholder checksums remain
untracked. Both checksum placeholders still name and hash older 2026-07-18
outputs, so they do not match the current JSON bytes. These files are not in
this catalog and are not release evidence.

## Legacy V2.1 Spike Live Status

`live-status.json` is the authority only for the older V2.1 spike artifacts
listed above (`aggregate-test.json`, `before-after-shadow.json`,
`config-sensitivity.json`, `data-readiness-coverage.json`, `golden-cases.json`,
and `performance-smoke.json`). It does not describe either 2026-07-19 native-Ad
replay.

If `live-status.json` says `attempted=false`, `DATABASE_URL` was missing, or no
live read occurred, do not describe those legacy artifacts as live DB/API
evidence.

At the time this provenance note was added, the checked `live-status.json` reported:

```json
{
  "attempted": false,
  "reason": "DATABASE_URL is not set; no live DB/snapshot read was attempted.",
  "missingEnv": ["DATABASE_URL"]
}
```

That means those legacy spike artifacts should be treated as fixture-backed
planning outputs unless regenerated later with a reviewed read-only live
loader. A retained native-Ad replay artifact instead carries its own embedded
transaction receipt, source/provenance manifests, release gate, full-drilldown
hash, and adjacent checksum contract; all of those checks must pass.

## Regeneration

Native-Ad artifacts are generated only through the existing local production
tunnel. The focused command and its exact four account bindings are documented
in
[`NATIVE_AD_ACCOUNT_AOV_AUTHORITY_2026-07-16.md`](../NATIVE_AD_ACCOUNT_AOV_AUTHORITY_2026-07-16.md).

The natural 2026-07-19 03:00 UTC wave completed, but its TheSwaf Main hydration
receipt failed the exact expected/hydrated manifest contract described above.
Do not regenerate or stage the failed 2026-07-19 outputs as release proof.
Those failed files and the obsolete local 2026-07-16 compact remain untracked
diagnostics and must not be staged.

The AOV replay intentionally selects a rollback-epoch baseline and replays the
current resolver as challenger on the same `--as-of` date. After the current
epoch is deployed, a later natural wave does not manufacture a rollback-epoch
anchor. Therefore a post-cutover date cannot be substituted into this replay,
and the replay must not be weakened into a current/current comparison. It
remains formula-parity evidence only.

The post-deploy natural-wave gate is the separate current-epoch operational
verifier. Run it only after the first complete natural 03:00 UTC wave, through
the existing read-only tunnel:

```bash
npm run creative:decision:native-ad-natural-wave-verify -- \
  --as-of=<successful-post-deploy-scheduler-date> \
  --deploy-anchor=<exact-final-deploy-timestamp> \
  --expected-business-count=12 \
  --expected-provider-account-count=13 \
  --expected-unbound=64df05ed-fd04-4274-968b-5bf122235e89 \
  --env-default-enabled=<exact-deployed-DECISION_ENGINE_V3_ENABLED>
```

The explicit environment default must come from the final deployed release
authority. Runtime uses `true` only when `DECISION_ENGINE_V3_ENABLED` is absent;
do not infer absence without release evidence.

The verifier imports the production current epoch and job names, reproduces
the scheduler population, and checks every current-wave chain, count, receipt,
manifest, authority, lineage, timeout, and unbound-business invariant in one
explicit repeatable-read/read-only transaction. Its deterministic JSON and
adjacent checksum stay under `/tmp`; no post-deploy evidence commit advances
main away from the deployed SHA. Never manufacture the wave with a manual cron
call, provider write, live database write, or business-specific bypass.

The historical closed-window verifier may be run only for a date that already
has a valid, passing focused/population authority pair from the intended
rollback/current overlap. It is not a substitute for the current-wave
operational verifier, and failed or mixed-date pairs remain fail-closed.

The older V2.1 spike artifacts use a separate tool:

Regenerate these artifacts from the separate spike tools branch once available:

```bash
npx tsx scripts/creative-decision-center-v21-spike.ts
```

Then verify:

```bash
npx vitest run scripts/creative-decision-center-v21-spike.test.ts
```

Do not run or add any script that mutates DB/API state. Spike tools must remain non-production and read-only.

## Data Safety

Do not store secrets, tokens, raw customer identifiers, or customer-sensitive
payloads in this folder. Exact business/provider-account identity is permitted
only in a reviewed, bounded proof where named-account or scheduler-population
coverage is itself an invariant. The retained
`mature-below-breakeven-temporal-replay-2026-07-16.json` uses that exception for
its four declared historical account scopes and remains explicitly
`review_only_reject_production_promotion`. A future native-Ad compact may use
the same exception only with `releaseGate.passed=true`. The failed 2026-07-19
diagnostics are not reviewed release proofs and remain untracked. A retained
proof must contain no provider token or customer/payment data; full native-Ad
row drilldowns remain outside the repository under `/tmp`.

If future generated artifacts include live data, sanitize or redact them before committing. Keep only fields necessary for regression planning and shadow validation.
