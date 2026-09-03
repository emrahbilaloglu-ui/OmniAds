# Meta automation — the two-key release posture, in three phases

**2026-09-03, for the D077–D088 release candidate.**

This runbook exists because "automation is OFF" was being used for two states
that produce identical database evidence and are not the same release:

- the capability is not present in the environment, so **nobody could enable a
  business even if they wanted to**; and
- the capability is present and every business is deliberately left off, so an
  admin **can** enable one through the UI ceremony whenever they choose.

The automation-OFF readback returns `PASS` for both — correctly, because it
measures database rows. But `PASS` was being read as "the release is
finished", and for the first state it is not: the product would ship a master
switch that silently refuses, which is the exact failure this release removes.

The phases below are enforced in code by
`lib/meta/automation-release-posture.ts`
(`classifyAutomationReleasePosture`), and the enforcement is asserted by
`lib/meta/automation-release-posture.test.ts`. The classifier reads nothing and
changes nothing: it names the phase from what an operator measured.

---

## Phase A — `predeploy_validation`

**What is true**

| Fact | Required value |
| --- | --- |
| `META_AUTOMATION_LIVE_WRITES` | absent, or any value other than `true` |
| Businesses with `auto_execution_enabled = TRUE` | `0` |
| `auto_execution_enabled` schema default | `FALSE` |
| `auto_execution_provider_account_id` | nullable, no default, no row bound |
| Per-decision-type standing mode | `manual` (Tier 1) for every business |

**What it is for.** Migration validation, the pre-deploy readback, and every
gate in this job. Nothing can execute: `lib/meta/budget-automation-scheduled.ts`
checks `gates.automationLiveWrites !== true` and returns `release_gate_closed`
before it touches the database at all.

**What it is NOT.** It is **not the finished release.** `describeAutomationPosture`
returns "Phase A · automation OFF and capability closed — NOT the final release
posture." so this cannot be quoted as a completion state.

**Exit condition.** An exact-SHA deployment, then a post-migration
automation-OFF readback in which every section returns `PASS`.

---

## Phase B — `capability_open_zero_enabled` · **the final desired posture**

**Reachable only after** both exit conditions of phase A are proven. The
classifier refuses to name phase B without them:
`exact_sha_deployment_unproven` and `post_migration_readback_unproven` are
returned as blockers and the verdict falls back to phase A.

**What is true**

| Fact | Required value |
| --- | --- |
| `META_AUTOMATION_LIVE_WRITES` | `true` |
| Businesses with `auto_execution_enabled = TRUE` | **`0`** |
| `auto_execution_enabled` schema default | `FALSE` |
| Deployed image | the exact SHA that was validated |
| Post-migration readback | every section `PASS` |

**What it means.** Enabling is *possible*; nothing is *enabled*. The UI master
switch is a live control rather than a decoration, and the two-key gate is
still closed on the second key: every business's per-decision-type mode remains
Tier 1 · manual, and the runtime re-checks both keys on every run.

**This is where the release stops.** Deployment does not enable a business, and
nothing in `lib/migrations.ts` writes to `meta_automation_business_controls` or
`meta_automation_decision_type_modes` — asserted, not assumed.

### The exact sequence from phase A to phase B

Six steps, in this order. Nothing here writes to
`meta_automation_business_controls` or `meta_automation_decision_type_modes` —
that table stays untouched until phase C, an operator action, not a release
step.

1. **Main, exact SHA — CI, then images.** Merge to `main`, let CI build and
   push the `web`/`worker` images tagged with that exact commit SHA. No
   deployment step ever floats to `latest`.
2. **Pre-deploy OFF audit.** A bounded, real host/DB readback against the
   CURRENTLY deployed environment, BEFORE deploying — three parts, all
   required: (a) the host env file, `META_AUTOMATION_LIVE_WRITES` in
   `.env.production`, normalized (trim + lowercase) and not `"true"`; (b)
   web's and worker's own LIVE process view of that same variable,
   normalized the same way, read via `docker compose exec`; (c) the nine
   sections `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md` declares,
   run as that document intends — pasted into `psql` against the real
   production `DATABASE_URL`, inside the ONE bounded `REPEATABLE READ READ
   ONLY` transaction the document itself opens, with its own bounded
   `statement_timeout`. Every section must read `PASS`.
   `scripts/automation-off-readback-seam.ts` is NOT this audit: it boots
   its own disposable, local, ephemeral PostgreSQL and proves the SQL
   itself is correct in both schema states — a correctness check on the
   readback document, never a substitute for running that document against
   production.
3. **Deploy, `run_migrations=true`.** `deploy-hetzner.yml`, exact SHA, with
   migrations enabled so the schema (including the D088/D077-era additions)
   lands before anything reads it.
4. **Post-migration OFF audit.** The SAME bounded real host/DB readback as
   step 2 — host env file, live web/worker gate, and the nine
   `docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md` sections against the
   real production `DATABASE_URL` in one bounded read-only transaction —
   run again, now against the migrated schema. Still every section `PASS`
   — this is phase A's own exit condition (above): an exact-SHA deployment
   plus a passing post-migration readback. Not
   `scripts/automation-off-readback-seam.ts` here either, for the same
   reason as step 2: it never touches the deployed environment.
5. **Capability workflow, `capability=open`.** Dispatch
   `.github/workflows/automation-capability-toggle.yml` with the exact
   deployed SHA, `capability=open`, and the typed confirmation phrase
   `OPEN_AUTOMATION_CAPABILITY`. It runs a read-only preflight
   (`lib/meta/automation-capability-preflight.ts`, checked against the global
   readback AND each of the six named businesses individually — IwaStore,
   Grandmix, Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR — refusing on any
   unknown or unreadable state), writes `META_AUTOMATION_LIVE_WRITES=true` to
   `.env.production` atomically with a timestamped backup, recreates `web` and
   `worker` at the exact SHA, and re-verifies both the runtime's own view of
   the env var AND the DB-backed preflight again. Any failure after the write
   restores the backup, forces the capability back closed, and the job fails —
   never partially open.
6. **Final verification.** `META_AUTOMATION_LIVE_WRITES=true` in the running
   environment AND zero businesses with `auto_execution_enabled = TRUE` in the
   database, together, is phase B — `capability_open_zero_enabled` — the final
   desired release posture.

**Workflow-green alone is not sufficient evidence step 5 succeeded.** The
capability-toggle workflow's own uploaded artifact
(`automation-capability-toggle-<sha>`) must be read, and its JSON body must
show `summary.result === "pass"` **and** `summary.blockers` is an empty array.
A green GitHub Actions run with a `result: "fail"` body inside the artifact
means the job's own "fail on anything but pass" step did its job — the run
still shows failed in that case — but any weakening of that step (or a check
that only looks at the job's pass/fail color and never opens the artifact)
would silently accept a refused or rolled-back attempt as success. Always open
the artifact and check `summary.result` and `summary.blockers` directly.

**Close (`capability=closed`) is fail-safe under DB failure by design** — the
close phase writes the env var and recreates, verified purely by runtime
env/build-id, and is never gated on a DB-backed preflight read. A close should
always be reachable even when the database is unreachable, which is exactly
the situation an operator would be closing capability in response to.

---

## Phase C — `business_enabled_by_operator`

An admin enables **one** business through the UI ceremony on the Meta
Automation surface: type the confirmation phrase, submit, and the server
re-derives readiness and binds the exact provider account.

This is a **user action, not a release step.** It is listed here only so that
observing it is not mistaken for a deployment defect.

---

## How to classify what you measured

```ts
import { classifyAutomationReleasePosture, describeAutomationPosture }
  from "@/lib/meta/automation-release-posture";

const verdict = classifyAutomationReleasePosture({
  envCapability: null,        // null = COULD NOT READ. Never pass false for "absent".
  enabledBusinessCount: 0,    // from the readback's master_switch section
  schemaDefaultsOff: true,    // from the readback's schema-defaults section
  deployedSha: null,          // the SHA proven running, or null
  readbackPassed: null,       // true only when every section returned PASS
});

console.log(describeAutomationPosture(verdict));
```

### The rules it enforces

1. **Unknown refuses first.** A `null` capability, a `null` enabled count or a
   `null` schema-default reading yields `phase: null`. A failed measurement is
   never filed as a passed one.
2. **An absent or false capability is never final.** `isFinalReleasePosture` is
   `true` for exactly one observation, and a test enumerates the whole state
   space to prove no other combination reaches it.
3. **An enabled business with the capability closed is a contradiction, not a
   phase.** It returns `business_enabled_while_capability_closed`: the row is
   inert today and becomes active the moment the capability opens, with no
   ceremony ever performed.
4. **Phase B requires its two preconditions.** Capability open without a proven
   SHA or a passing readback is reported as phase A with named blockers, and
   the recommended action is to close the capability again.

---

## Where each key actually lives

| Key | Where | Default | Who changes it |
| --- | --- | --- | --- |
| Environment capability | `META_AUTOMATION_LIVE_WRITES`, read by `lib/meta/release-gates.ts` | closed — only the exact string `true` opens it | release owner, on the host, phase A → B |
| Business master switch | `meta_automation_business_controls.auto_execution_enabled` | `FALSE`, `NOT NULL` | an admin, through the UI ceremony, phase C |
| Per-decision-type mode | `meta_automation_decision_type_modes` | `manual` (Tier 1) | an admin, per decision type |

All three are re-checked by the server on **every** scheduled run. None of them
is exposed as `NEXT_PUBLIC_*`, and none of them is granted by a gate: a gate
decides what the product *offers*, never what it *permits*.

> **This job did not touch the real environment.** Every statement here is about
> what the tree ships and what the classifier will say; the operator's actual
> `META_AUTOMATION_LIVE_WRITES` was neither read nor written.
