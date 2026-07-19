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
Wait for the first complete natural post-deploy scheduler wave and use that
wave's actual date in the final filenames and commands. Source/test readiness
is not a substitute for scheduler-owned anchors. Never manufacture them with a
manual cron call or any live write.

The command below records the failed 2026-07-19 diagnostic shape only. For
final release evidence, replace the operational `--as-of`, `--json-out`,
`--compact-json-out`, and same-date sibling path with the actual successful
post-deploy scheduler date and regenerate the focused sibling with that same
date before staging either artifact. Keep the two explicitly repeated
2026-07-19 paths unchanged: they are known failed, non-evidence outputs and
must stay outside the repository-content proof even when the passing pair uses
a later date.

```bash
npm run creative:decision:native-ad-account-aov-replay -- \
  --as-of=2026-07-19 \
  --audit-provider-account=172d0ab8-495b-4679-a4c6-ffa404c389d3:act_822913786458311 \
  --audit-provider-account=f8a3b5ac-588c-462f-8702-11cd24ff3cd2:act_1087566732415606 \
  --audit-provider-account=a7fd8563-8c9a-497a-b0d7-fd65e4248d1f:act_1054905059780305 \
  --audit-provider-account=5dbc7147-f051-4681-a4d6-20617170074f:act_805150454596350 \
  --json-out=/tmp/native-ad-account-aov-authority-replay-2026-07-19-population-final-full.json \
  --compact-json-out=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json \
  --stdout=none
```

`--audit-provider-account` is an audit-only scope. It never filters the replay
query. An unfiltered scheduler-population run requires the complete four-account
audit scope and gates both that cohort and the full scheduler population inside
the same repeatable-read/read-only transaction.

Both commands enforce read-only transaction/runtime settings and reject a
missing existing tunnel. The obsolete local v6 compact is explicitly excluded
from provenance so it cannot become undeclared release evidence. The two final
v7 artifacts must be regenerated only after every intended source, test, and
document is staged; tracking status is part of the repository-content manifest.
Do not stage any JSON or checksum unless both newly dated replays exit zero and
report `releaseGate.passed=true` after the post-deploy natural wave. After both
pass, write each adjacent checksum from `shasum -a 256`, stage the final
JSON/checksum outputs, recompute the manifest against the staged tree, and run
the replay provenance tests. Declaring the sibling compact JSON artifact as a
provenance exclusion prevents later outputs from invalidating the pre-output
repository manifest. The replay automatically expands its own output and every
declared sibling JSON exclusion to the adjacent checksum and temporary sibling;
callers must not list those derived paths separately, and non-JSON exclusions
fail closed.

The historical closed-window verifier requires the same scheduler date
explicitly:

```bash
npm run creative:decision:native-ad-account-aov-closed-window -- \
  --authority-as-of=<successful-post-deploy-scheduler-date> \
  --account='TheSwaf Main:act_822913786458311' \
  --account='IwaStore:act_1087566732415606' \
  --account='EMOLOS:act_1054905059780305' \
  --account='Grandmix:act_805150454596350'
```

There is no date default. The verifier derives both compact paths, both
sidecars, and the exact repository exclusions from this one value; a mixed-date
pair, a checksum mismatch, a pre-03:00 UTC artifact, a failed release gate, or
an exclusion manifest that omits the obsolete 2026-07-16 and failed 2026-07-19
outputs fails closed.

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
