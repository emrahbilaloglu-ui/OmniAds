# D081 — Meta budget capability foundations (2026-09-01, Correction 5)

**Operating class: prepare.** No provider call, no Meta mutation, no shared-database
write, no migration written or executed, no UI, no deployment, no automation
activation. All six execution flags remain unset. No manual Test/Main/Mixed
label was restored, read, or used as a tie-breaker.

---

## Verdict

**One blocker is closed as an integrated canonical capability. One is closed as
a frozen-data resolution. The third is implemented but resolves nothing,
because the retained data cannot satisfy the canonical authority rule — and
that is reported as a data gap, not repaired by assumption.**

| Blocker | Closure class | Rows | Basis |
|---|---|---|---|
| `decision_vocabulary_absent` | **implemented and integrated canonical capability** | 247,050 | a budget intent is now a discriminated member of `MetaOsDecisionAction` |
| `unit_exponent_unknown` | **frozen-data resolvable** | 247,050 | every observed currency resolves against a versioned ISO registry |
| `role_authority_absent` | **residual data gap** | **0** | the snapshot retains neither `kind_source` nor `resolver_version`; absent provenance fails closed |

**Zero proposals became preview-eligible.** Nothing is executable, and no
provider write path exists.

---

## 1. What Correction 1 changed, and why the first attempt was rejected

Independent acceptance found the three modules had **zero runtime importers**:
a standalone type is not a closed vocabulary blocker. Four further defects were
reproduced before any edit:

| # | Defect | Reproduced |
|---|---|---|
| 1 | modules detached from the canonical contract | zero runtime imports |
| 2a | row-scoped evidence from **another business** granted authority | `satisfiesRoleAuthority: true` |
| 2b | account-null evidence from another business + valid identity granted authority | `satisfiesRoleAuthority: true` |
| 3 | `medium` and `low` confidence granted authority | `true` for both |
| 3b | resolver version never consulted | absent from provenance |
| 5 | idempotency key omitted the operation | two different amounts shared one key |

All six now fail closed.

### The canonical boundary

`lib/meta/decisions-os-contract.ts` gains an **optional** discriminated member:

```
MetaOsDecisionAction.budgetIntent?: MetaOsBudgetIntentPayload  // kind: "budget_intent"
```

Optional matters: every existing creative/ad action serializes byte-identically
to before the field existed, asserted by an exact-string test.
`toCanonicalDecisionAction` is the only producer; it serves `intent: "review"`,
never `execute`, with `providerMutation: null`. `MutationAction`,
`MUTATION_ENDPOINTS` and `meta_automation_proposals` are **not** widened —
D080A established that an approvable action with no endpoint could only ever
fail. `DECISION_LOG.md` carries the ADR.

### Role authority now reuses the canonical rule

`source === "system_inferred"` **and** `confidence_class === "high"` **and** a
validated resolver version, through the same
`isCampaignContextResolverAuthorityValidated` the decision surface uses.
Evidence is keyed by the full composite scope. With no validator injected the
default is refusal, not a free pass.

### Idempotency now binds the operation

The key hashes scope **plus** owner mode, currency, exponent, current and
proposed minor units, and all three source fingerprints. Raising 100,000 by 10%
and raising 900,000 by 10% no longer share an identity, while deterministic
re-derivation of the same intent stays stable.

---

## 1b. Correction 2 — real runtime consumers, exact source authority, lossless payload

Independent acceptance rejected Correction 1 with four blockers, all reproduced
before any edit:

| # | Blocker | Reproduced |
|---|---|---|
| 1 | zero runtime importers of either capability | `runtime_role_importers=0`, `runtime_budget_producer_importers=0` |
| 2 | `system_inferred` declared but not enforced | `null`, `unknown`, `batch_import`, `legacy_label` all returned `true` |
| 3 | canonical payload lossy; invalid budget branch constructible | 15 bindings omitted; `execute` + `pause` accepted |
| 4 | campaign name still an authority channel | Main/high reachable from a rename |

**1 — real server-side consumers.** Both capabilities are now called by
existing canonical modules, not only defined:

- `lib/meta/decisions-workspace-read-model.ts:26` imports and `:909` calls
  `evaluateAccountScopedRoleAuthority`; `trustedForAction` is now its result
  rather than a second copy of the rule.
- `lib/meta/decisions-os-presentation.ts:20` imports `toCanonicalDecisionAction`
  and exports `canonicalBudgetAction` / `withCanonicalBudgetActions` — the
  server-side seam that folds validated intents into an existing action list.
  With no intents it returns the **same array reference**, so every existing
  surface is byte-identical and cannot regress. The seam decides nothing: no
  rung, no entity, no policy, no persistence, no provider verb.

**2 — `system_inferred` is now an allow-list.** The earlier form refused a
handful of known manual origins and let everything else through. The source
must now equal exactly `system_inferred`, with no trimming or case folding;
`null`, `unknown`, `batch_import`, `legacy_label`, `user_override`,
`bulk_apply_confirmed`, `""`, `SYSTEM_INFERRED` and `"system_inferred "` all
fail closed with `role_source_not_system_inferred`. The source is never
inferred from a table name, and `kindSource` is a required field so absence
must be stated rather than defaulted.

**3 — the payload is lossless and the union is real.**
`MetaOsBudgetIntentPayload` is defined once in the served contract and carries
**all 29** required bindings — scope with parent campaign identity, owner mode,
currency registry, delta, rounding provenance, all four clocks, source
fingerprints, evidence window, target source, rollback and read-back. A test
asserts `Object.keys(intent).filter(k => !(k in payload))` is empty and that
every carried value is identical. `MetaOsDecisionAction` is now a genuine
compile-time union: the legacy branch has `budgetIntent?: never`, the budget
branch requires `intent: "review"`, `providerMutation: null` and a
campaign/adset target. `assertCanonicalDecisionAction` enforces the same rule
at runtime for JSON consumers; six invalid combinations are refused.

**4 — the name channel is closed at the resolver boundary**, recorded in the
ADR before implementation. The high-confidence gate now counts only non-naming
agreeing families **and** is evaluated on a naming-free score, for every kind.
Excluding naming from the family count alone was insufficient — its weight
still moved `topScore` and `margin`, and a test caught a rename lifting an
unnamed campaign to `high`. Naming keeps its reported weight, so it remains
explanatory and can still hold medium. **Correction 5 supersedes the claim that
conflict detection is unchanged: a naming conflict no longer removes
authority.** Eleven
campaign names, including adversarial ones, now produce a single identical
authority answer. **No manual label is restored.**

---

## 1c. Correction 3 — the last real runtime, source and rounding gaps

Correction 2 was rejected on three fresh post-completion attacks. All were
reproduced before any edit.

**Blocker 1 — the budget path was an unused wrapper.** The route calls
`buildMetaOsDecisionsPresentation`, whose input had no budget parameter;
`canonicalBudgetAction` and `withCanonicalBudgetActions` had **zero** non-test
callers, and the C2 test built a local action array — exactly what the previous
prompt called insufficient.

Now the real path carries it end to end:

```
app/api/meta/decisions-workspace/route.ts:1700   buildMetaOsDecisionsPresentation({...})
lib/meta/decisions-os-presentation.ts            input.budgetIntents?: readonly ValidatedBudgetIntent[]
lib/meta/decisions-os-presentation.ts            toCanonicalDecisionAction(intent) -> assertCanonicalDecisionAction
lib/meta/decisions-os-contract.ts                MetaOsDecisionsPresentation.budgetReview?: { actions, count }
```

The served block is **optional and spread**, so with no intents the key is
absent and the payload is byte-identical to a build without the parameter — a
test asserts exact string equality and that `budgetReview` never appears. The
builder assembles and never decides: no rung, entity, magnitude, persistence,
dispatch verb or provider access. The two superseded wrappers were **deleted**
rather than left as unused exports.

**Blocker 2 — the runtime fabricated `system_inferred`.** The column exists and
the job persists it, but the reader's SELECT omitted `kind_source` and the
mapping wrote `source: "system_inferred" as const` whenever the mode was
automatic and the kind parsed. The exact-source rule was therefore checking a
value the reader had invented. The SELECT now reads `inferred.kind_source`.

**Correction 4 withdraws the whitespace half of that claim as originally
written.** The comparison used `text(row.kind_source)`, which trims first, so
`" system_inferred"` and `"system_inferred "` were in fact accepted. A second
arm still synthesized `system_inferred` from `mode === "automatic"` and the
presence of a context timestamp. See §1d.

Fixing this surfaced a second defect of my own: the canonical resolver validator
was being called **twice** per row, so a caller stubbing it per-call got
different behaviour. An existing suite caught it. It is now called exactly once
and the single result is reused; a test pins the call count at one.

**Blocker 3 — V3 rounding let a rename create authority.** The naming-free high
score was computed by subtracting the naming term from an already-rounded
inclusive score. With lifecycle absent and weights renormalised, that double
rounding crossed the 0.6000 threshold:

| `campaignName` | before | after |
|---|---|---|
| `null` | main / **medium** / 0.5999 | main / medium / 0.5999 |
| `"CORE evergreen scale"` | main / **high** / 0.7176 → **authority granted** | main / **medium** / 0.7176 → no authority |

Both resolvers now sum the non-naming weighted terms directly and round **once**.
The exact fixture runs at the real resolver-to-authority boundary, and eight
names — including adversarial ones — produce a single identical authority
answer. Conflict behaviour is unchanged; no manual label is restored.

---

## 1d. Correction 4 — raw equality, both arms, tested at the real reader

Correction 3 claimed whitespace variants of `kind_source` mapped to `unknown`.
They did not. The runtime compared `text(row.kind_source)`, and `text()` trims:

| raw persisted value | Correction 3 | required |
|---|---|---|
| `"system_inferred"` | `system_inferred` | `system_inferred` |
| `" system_inferred"` | **`system_inferred`** | `unknown` |
| `"system_inferred "` | **`system_inferred`** | `unknown` |
| `"SYSTEM_INFERRED"` | `unknown` | `unknown` |

A second occurrence of the same defect survived at the **unresolved** return
arm, which still set `source: "system_inferred"` from `mode === "automatic" &&
hasAutomaticContext` without consulting the row at all. `kind: null` kept it out
of hard authority, but the served provenance was still fabricated.

And my C3 test did not exercise the reader: it defined a local `map`/`trust`
pair using raw equality, so it passed while the reader trimmed — the precise
failure mode the previous correction had already called out.

**Fix.** One dependency-safe helper, raw equality only:

```ts
export function exactCampaignContextSource(value: unknown) {
  return value === "system_inferred" ? "system_inferred" : "unknown";
}
```

No `text()`, no `trim()`, no case folding, no inference from mode, table
presence or timestamps. It is used in **both** return arms —
`source: exactCampaignContextSource(row.kind_source)` appears exactly twice, and
a test pins that count.

**Verified at the real reader**, through the mocked `getDb()` path, then fed
into the real `buildMetaDecisionsWorkspaceReadModel`:

| raw `kind_source` | reader `source` | `trustedForAction` |
|---|---|---|
| `"system_inferred"` | `system_inferred` | **true** |
| `null`, missing, `""` | `unknown` | false |
| `" system_inferred"`, `"system_inferred "` | `unknown` | false |
| `"SYSTEM_INFERRED"`, `"unknown"` | `unknown` | false |
| `legacy_label`, `user_override`, `manual`, `operator`, `batch_import`, `bulk_apply_confirmed` | `unknown` | false |

Every other gate is valid in that table — high confidence and a validated
resolver version — so the source is the only thing that differs. The unresolved
arm is covered separately: a non-exact source is served as `source: "unknown"`,
and only an exact one is served as `system_inferred`, with `kind: null` either
way.

The synthetic local map was deleted; the runtime-consumer suite now only asserts
that the behavioural coverage lives in the reader suite and that it does not
reimplement the mapping again.

---

## 1e. Correction 5 — resolver identity and name neutrality on every branch

Two defects, both reproduced before any edit, both with **non-vacuous**
fixtures where authority was genuinely `true` under one name and `false` under
another.

**Defect 1 — the identity did not move with the semantics.** Correction 2
changed high-confidence semantics but left both resolver strings at their
pre-change values, so a row computed by the old algorithm was indistinguishable
from a new one. Once approved, stale name-load-bearing rows could masquerade as
safe — the exact thing D074 requires a version bump to prevent.

| | retired (never approvable) | new |
|---|---|---|
| v2 (live) | `campaign-context-resolver.v2-account-scoped-2026-08-29` | `campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01` |
| v3 (challenger) | `campaign-context-resolver.v3-lifecycle-2026-08-29` | `campaign-context-resolver.v3-lifecycle-name-neutral-2026-09-01` |

Only the exact newly compiled default identity is approvable. The retired v2
string fails validation **even when the environment is set to that exact
string**, because approval compares the env value to the compiled constant.
Null, empty, whitespace and case variants, the v3 identity and arbitrary
strings all fail; unset approves nothing.

**Defect 2 — three name channels survived outside the C2 high gate.**

| Branch | before | after |
|---|---|---|
| `strongTestSignature` vetoed by `namingMain` | `null → {true, test}`; `"CORE evergreen scale winner" → {false, null}` | both `{true, test}` |
| `naming_contradicts_behavior` forcing `conflict` | `null → {true, main}`; `"TEST new angle" → {false, null}` | both `{true, main}` |
| `topKind` chosen from naming-inclusive scores | name decided which kind the naming-free gate evaluated | `topKind` derived from naming-free scores |

The fix, in v2 and v3: the strong-Test shortcut no longer consults
`namingMain`; `naming_contradicts_behavior` is still **recorded as evidence**
but no longer forces the class — only non-naming reasons populate the
authoritative conflict list; and `topKind` comes from naming-free scores.
Naming keeps its weight and evidence entry and may still shape
non-authoritative medium/low presentation.

**This explicitly supersedes the Correction 2 statement that a name may still
block.** It may not: a name can neither promote, veto, preserve nor change a
hard-authoritative result.

**Verification is non-vacuous by construction.** Six branch fixtures —
strong-Test signature, normal high Main, normal high Test, Mixed candidate,
borderline margin, below-floors unknown — of which the suite asserts **exactly
three are genuinely authoritative across more than one kind**, so equal answers
cannot come from universal denial. A deterministic matrix then compares the
full tuple `{ satisfiesRoleAuthority, authoritativeKind }` across 2 resolvers ×
6 branches × 4 spend/turnover perturbations × 14 names = **672 comparisons**,
every one identical to its unnamed baseline.

Unrelated gates are untouched: hard authority still requires exact
`system_inferred`, exact `high`, the exact validated resolver identity, full
composite account scope and freshness. No manual label is restored.

**Replay unchanged**: role resolvability stays 0 because the frozen D080B
snapshot retains neither `kind_source` nor `resolver_version`; the identity
change does not alter that.

---

## 2. Replay: denominators and all four dimensions

Denominators unchanged from D080B: **247,050** proposals ·
17 origins · 2,430 entities ·
7 accounts · 6 businesses.

### By business

| Business | Proposals | Vocabulary | Unit | Role | No residual |
|---|---|---|---|---|---|
| Bilsem Zeka | 58,100 | 58,100 | 58,100 | 0 | 0 |
| ColorFullWorldsTR | 10,510 | 10,510 | 10,510 | 0 | 0 |
| Grandmix | 124,050 | 124,050 | 124,050 | 0 | 0 |
| IwaStore | 19,820 | 19,820 | 19,820 | 0 | 0 |
| IwaTR | 2,630 | 2,630 | 2,630 | 0 | 0 |
| TheSwaf | 31,940 | 31,940 | 31,940 | 0 | 0 |

### By account (selected vs deselected preserved)

| Account | Business | Selected | Proposals | Unit | Role | No residual |
|---|---|---|---|---|---|---|
| `act_1087566732415606` | IwaStore | yes | 19,820 | 19,820 | 0 | 0 |
| `act_2335220976649516` | IwaTR | yes | 2,630 | 2,630 | 0 | 0 |
| `act_3554615364751964` | ColorFullWorldsTR | yes | 10,510 | 10,510 | 0 | 0 |
| `act_805150454596350` | Grandmix | yes | 124,050 | 124,050 | 0 | 0 |
| `act_822913786458311` | TheSwaf | yes | 25,130 | 25,130 | 0 | 0 |
| `act_840779107261785` | Bilsem Zeka | yes | 58,100 | 58,100 | 0 | 0 |
| `act_921275999286619` | TheSwaf | **no** | 6,810 | 6,810 | 0 | 0 |

### By grain

| Grain | Proposals | Vocabulary | Unit | Role | No residual |
|---|---|---|---|---|---|
| adset | 167,960 | 167,960 | 167,960 | 0 | 0 |
| campaign | 79,090 | 79,090 | 79,090 | 0 | 0 |

### By fold

| Fold | Proposals | Vocabulary | Unit | Role | No residual |
|---|---|---|---|---|---|
| fold_1 | 48,630 | 48,630 | 48,630 | 0 | 0 |
| fold_2 | 68,510 | 68,510 | 68,510 | 0 | 0 |
| fold_3 | 84,910 | 84,910 | 84,910 | 0 | 0 |
| fold_4 | 45,000 | 45,000 | 45,000 | 0 | 0 |

**Reconciliation:** every dimension sums to 247,050 —
business 247,050, account
247,050, grain 247,050,
fold 247,050. `reconciles: true`.

---

## 3. Residual blockers

| Blocker | Before | Residual |
|---|---|---|
| `decision_vocabulary_absent` | 247,050 | **0** |
| `unit_exponent_unknown` | 247,050 | **0** |
| `role_authority_absent` | 247,050 | **247,050** |
| `spend_evidence_floor` | 235,820 | 235,820 |
| `owner_evidence_absent` | 216,340 | 216,340 |
| `status_evidence_absent` | 216,340 | 216,340 |
| `parent_not_active` | 164,090 | 164,090 |
| `commercial_target_absent` | 133,040 | 133,040 |

Every blocker outside D081's three targets survives unchanged, asserted row by row.

### Why role authority resolves nothing

| Fact | Value |
|---|---|
| retained automatic role rows in window | 3,058 |
| of those carrying a provider account | **0** |
| of those carrying a `kind_source` | **0** |
| of those carrying a `resolver_version` | **0** |
| observed identities available for scoping | 462 |

Outcome census across all 247,050 rows: `no_campaign_identity` 147,760 · `role_evidence_absent` 81,480 · `role_source_not_system_inferred` 13,360 · `role_evidence_future` 4,450.

The canonical rule needs `source === "system_inferred"` **and** confidence
`high` **and** a validated resolver version. The D080B `roleContext` read
selects `campaign_id`, `as_of_date`, `inferred_kind`, `confidence_class` and
`provider_account_id` — so **two of those three provenances were never
captured**. The source gate is earlier in the ladder, so it is the blocker the
census records; repairing only `resolver_version` would not resolve a single
row. **The earlier 7,150 figure came from a weaker rule and is withdrawn.**

---

## 4. Currency

All seven accounts resolve: six USD and one TRY, each exponent 2. Both are
exponent-2 by ISO, so a blanket `/100` would have worked today and broken on
the first JPY (0) or KWD (3) account. The registry transcribes 17 zero-decimal,
7 three-decimal and 40 two-decimal codes, refuses unknown codes, and refuses
redenominated codes such as `TRL` loudly.

---

## 5. Manual labels cannot influence authority

An independent read-only audit found **no writable manual Test/Main/Mixed input
in live runtime**: the `PUT /api/meta/campaign-labels` route is a 410 tombstone,
`meta_campaign_labels` has no live writer, and the sole producer of
`engine_v3_campaign_context_daily` writes `'system_inferred'` as a SQL literal
no caller can parameterise.

The new module additionally, by test: has **no input field** through which a
label could be supplied (asserted against the declared interface surface, so
its own prose and its published rule cannot satisfy the claim); **refuses** any
manual-origin row outright rather than using an automatic sibling as a
tie-breaker; and **never reads a campaign name**.

**Two residual risks, reported not silently fixed:**

1. `resolver.ts:519-526` enforces *"naming alone can never produce
   high-confidence Test"* — **for Test only**. For **Main**, a name token can be
   one of the two agreeing families producing `confidence_class: "high"`.
   Campaign names are human-authored, so this is a real human→authority channel.
   Changing resolver scoring is a product behaviour change requiring its own
   ADR. **D081's role authority is immune — it never reads a name.**
2. `campaign-label-guard.ts:339-355` stamps `contextTrust: "high"` from manual
   rows. All callers are under `scripts/`; **D081 adds a test** that fails if
   `app/`, `components/` or `lib/` imports it.

---

## 6. What this still does not do

Closing these blockers does not make a proposal executable. Unchanged from
D080B: evidence floors, delivery and parent status, commercial target presence
and freshness, budget-binding, cooldown, oscillation, concentration and fleet
caps, CAS drift, ambiguous provider outcome, idempotency collision, rollback
exposure and kill-switch. All causal lift fields remain `null`; historical
transitions remain observational only.

---

## 7. Reproducibility

The compact artifact is rebuilt from the pinned D080B file plus this
repository's code and compared field by field — no self-authored hash is the
sole verifier. Nineteen tamper attacks are rejected, including forged
dimensional breakdowns, fold totals, the reconciliation flag, the
canonical-integration claim and the role rule. Future leakage is proven at the
real selector boundary with negative controls in both directions.
