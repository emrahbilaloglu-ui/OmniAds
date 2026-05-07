CHATGPT_REVIEW_READY: YES
ROLE: CODEX_WIP_IMPLEMENTATION
BRANCH: wip/creative-v2-readonly-ui-preview-2026-04-26
SANITIZED: YES
PRODUCT_CODE_CHANGED: NO
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Session Observations

Session packet generated: 2026-04-27

This file records sanitized observations for the limited read-only operator
preview session. It is intentionally report-only. No product code, resolver
logic, v1 behavior, queue/apply behavior, Command Center wiring, DB write path,
or Meta/platform write path is changed by this packet.

# Session Status

Human supervisor/operator interview status: completed.

Codex recorded live supervisor answers in sanitized form. No buyer response is
fabricated.

# Sanitization Rules

Do not record:

- raw customer names
- raw account names
- raw creative names
- raw campaign names
- raw adset names
- private screenshots
- browser session values
- cookies
- tokens
- environment variables
- self-hosted DB URLs
- server credentials

Use sanitized row aliases only.

# Technical Baseline From Authenticated Preview Validation

Evidence source:

- `docs/operator-policy/creative-segmentation-recovery/reports/v2-readonly-ui-preview-2026-04-26/authenticated-preview-screen-notes.md`

| Check | Result |
| --- | --- |
| Self-hosted dev/internal workspace | yes |
| V2 preview off by default | yes |
| V2 preview rendered with query param | yes |
| V1 remained visible/default | yes |
| Today Priority rendered | yes |
| Diagnose collapsed by default | yes |
| Inactive Review collapsed by default | yes |
| Forbidden action language visible | 0 |
| Internal artifact terms visible | 0 |
| Safe read-only action buttons visible | 6 |
| V2 detail/open app writes | 0 |
| Direct-actionability rows in workspace | 0 |

# Live Moderator Session Results So Far

Runtime context:

- App URL mode: local browser URL on `localhost:3000`.
- Database path: self-hosted PostgreSQL reached through the approved local
  tunnel path.
- Environment handling: local worktree environment file was restored without
  printing secret values.
- No product code was changed during the session.

Normal no-flag page:

| Field | Sanitized result |
| --- | --- |
| URL | `http://localhost:3000/platforms/meta/creatives` |
| no_flag_v2_preview_visible | false |
| no_flag_v1_normal | true |
| no_flag_notes | Supervisor reported that `Read-only buyer preview` was not visible on the normal Creative page. |

V2 preview page:

| Field | Sanitized result |
| --- | --- |
| URL | `http://localhost:3000/platforms/meta/creatives?creativeDecisionOsV2Preview=1` |
| with_flag_v2_preview_visible | true |
| with_flag_v1_still_visible | unknown |
| today_priority_visible | unknown |
| diagnose_collapsed_by_default | unknown |
| inactive_review_collapsed_or_muted | unknown |
| with_flag_notes | Preview visible and understandable; buyer UX hesitations recorded below. |

Additional operator notes:

- `Scale-worthy` showing zero caused interpretation hesitation.
- A later direct-actionability prompt suggested Diagnose may be interpreted as a
  confirmation/review area.

# Operator Answers

## 1. Within 5 seconds, do you know what needs attention today?

Sanitized operator response: mostly yes. Supervisor estimated clarity at about
85%, indicating the page communicates today's focus but still leaves some
interpretation friction.

## 2. Which creative would you inspect first?

Sanitized operator response: supervisor would inspect spend-heavy loss-making
rows first. This maps to high-spend / bleeding-spend Cut or loss-control
candidates rather than a named creative.

## 3. Which creative, if any, looks scale-worthy?

Sanitized operator response: supervisor believes at least one creative appears
scale-worthy, but the panel's `Scale-worthy` summary shows zero. This is a
scale-candidate clarity mismatch and should be treated as a buyer UX hesitation.

## 4. Which creative, if any, looks like a cut candidate?

Sanitized operator response: yes. Supervisor saw at least one cut candidate.
No raw creative name was recorded.

## 5. Which creative, if any, needs refresh?

Sanitized operator response: yes. Supervisor saw at least one refresh candidate.
No raw creative name was recorded.

## 6. Which rows make you hesitate?

Sanitized operator response: no row-level hesitation reported so far. The only
reported hesitation is the `Scale-worthy` summary count showing zero despite
the supervisor perceiving at least one possible scale candidate.

## 7. Are Diagnose rows useful or too dominant?

Sanitized operator response: Diagnose area exposed a usability issue. The
`Investigate` control inside Diagnose was visible but did not perform an
observable action when clicked. This is a preview UI iteration item. It was not
reported as unsafe write behavior.

## 8. Are inactive rows separated clearly?

Sanitized operator response: yes. Supervisor reported inactive/passive
creatives are separated clearly.

## 9. Is any button/action wording unsafe or misleading?

Sanitized operator response: no. Supervisor did not see unsafe action language
such as Apply, Queue, Push, Auto, Scale now, Cut now, or Approve.

## 10. Does this feel like a senior media buyer panel or still like an internal diagnostic tool?

Sanitized operator response: the panel does not feel like a technical/internal
system report. It is closer to a senior media buyer panel.

# Direct-Actionability Observation

Current authenticated demo workspace:

- Direct-actionability rows present: 0.

Visual proof of review-only Scale/high-spend Cut ranking above direct
Protect/Test More is therefore not available from this workspace. Fixture-backed
sort tests remain the supporting evidence. This remains a tracking item for
merge/product-ready readiness.

Live supervisor observation:

- A separate direct-actionability / buyer-confirmation row was not clearly
  observed during the moderated session.
- Supervisor interpreted Diagnose as possibly serving that purpose. This is a
  section-meaning clarity issue, not direct-actionability ranking evidence.

# Blocking Hesitations

Recorded so far:

- The `Scale-worthy` summary count showing zero was not immediately clear to
  the supervisor. This is a copy/expectation hesitation, not a write-safety
  issue.
- The Diagnose `Investigate` control appeared interactive but did not perform
  an observable action. This creates a buyer workflow hesitation and requires UI
  iteration before product readiness.
- Direct-actionability / confirmation meaning was not clearly distinguished
  from Diagnose in the live session.

# Safety Observation

| Field | Sanitized result |
| --- | --- |
| unsafe_action_language_visible | false |
| internal_artifact_language_visible | false |
| row_detail_readonly | true |
| db_write_observed | unknown |
| meta_platform_write_observed | unknown |

Supervisor opened/read the preview enough to check action language and reported
no Apply, Queue, Push, Auto, Scale now, Cut now, Approve, or live-write style
control. DB and Meta/platform writes were not directly observable by the
supervisor during this moderated question.

If a blocking buyer hesitation is observed during the session, record it here in
sanitized form and do not patch resolver/UI behavior without a new ChatGPT fix
decision.

# Continue Limited Preview?

Current status: continue only as limited read-only preview evidence gathering.

This is not product-ready and not merge-ready. Queue/apply, Command Center,
database writes, Meta writes, and platform writes remain out of scope.

# Infrastructure Notes

- Active site runtime: self-hosted server.
- Active DB runtime: self-hosted PostgreSQL database.
- Vercel and Neon are deprecated infrastructure.
- Vercel queued/skipped checks are not active product blockers.
- Neon-specific wording is legacy and not active DB infrastructure.
- Active runtime validation should refer only to the self-hosted server and
  self-hosted DB.
