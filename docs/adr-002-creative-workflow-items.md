# ADR-002 — `creative_workflow_items`: a creative request/production workflow

**Status: PROPOSED. NOTHING IN THIS DOCUMENT IS IMPLEMENTED.**

This is a PROPOSAL, and it remains one. No schema, route, or callback from this
document exists in the tree, and none may be added on the strength of this
document alone — it is to be accepted or rejected, not a plan already in motion.

**What changed since this was written.** The Creative Inbox no longer draws the
four columns this ADR is about. Naming them (Requested / In production /
Delivered / Live) was itself the claim that the pipeline existed, and a caption
underneath could not withdraw it. The surface now shows the content it really
does read — the scoped creative-briefing decision items, in the briefing
authority's own served sections (`actionNow`, `watching`, `healthy`) — and says
in its own routing strip that requesting, versioning, approving and handing off
a creative are *not built*.

That is a presentation fix, not this ADR. The workflow below is still entirely
unbuilt: no `creative_workflow_items` table, no status transition, no owner, no
due date, no file, no version, no approval, no handoff. Everything from §3
onward describes what building it would require.

---

## 1. Context — what is actually missing

The design's Inbox is a four-column production board (Requested, In production,
Delivered, Live), and **no creative workflow backend exists anywhere in this
product** to fill it. That is a stated fact with a re-runnable proof, recorded
in the header of
`app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx` and in
`CreativeInboxColumnId` in
`components/creatives/creative-studio-exact-types.ts`:

```
grep -rn --include='*.ts' --include='*.tsx' \
  -E 'workflowStatus|workflow_status|columnId|column_id' app lib components
grep -rn --include='*.ts' --include='*.tsx' \
  -E '\bassignee\b|assigned_to|assignedTo' app lib components
grep -rn --include='*.ts' --include='*.tsx' \
  -E 'dueAt|due_at|dueDate' app lib components
grep -rn --include='*.ts' --include='*.tsx' \
  -E 'versionNumber|approvalState|approvedBy|approved_by' app lib components
```

Every live hit belongs to something else:

- `lib/decision-workflow.ts` + `decision_workflow_state` /
  `decision_workflow_events` (`lib/migrations.ts:7388-7437`) are the **DECISION
  ownership overlay** — `open / acknowledged / deferred / snoozed / rejected /
  resolved` on a `decision_key`. Its own module header is explicit: "no
  transition here can change a decision's label, its authority, or whether a
  provider action is permitted." It records who owns a *recommendation*. It does
  not model a creative request moving Requested → In production → Delivered →
  Live, and it records no delivered file, version or approval.
- Everything named `command_center_*` sits under `lib/archive/v1-v2-v21/`.

The endpoint the board would read serves no workflow field either:
`/api/creatives/inbox` forwards `/api/creatives/briefing`'s `actionNow`,
`watching` and `healthy` cards with a `businessId` stamped on. **A route name is
not backend proof** — that route's only caller, `CreativeInboxClient` in
`components/zero-base/creative/studio-clients.tsx`, is imported by no route at
all, and the Inbox page reads `/api/creatives/briefing` directly.

So the choice this ADR exists to settle is: *build a real creative workflow, or
keep saying there isn't one.* Until it is accepted, the second answer stands.

## 2. Non-goals

- **Not a decision store.** A workflow item may *cite* a decision; it may never
  change one. `INVARIANTS.md` — "A blocked, held, review-only, or
  action-ineligible canonical decision must not map to any Launchpad mode" — is
  unaffected by anything here, and `rebuild_creative` stays review-only whatever
  a workflow card says.
- **Not an execution authority.** Reaching `live` is a *recording* that an ad
  went live. It never grants a provider write, and it never substitutes for the
  origin contract and fresh exact provider GET that execution requires.
- **Not a DAM.** File storage is a pointer plus a checksum (§6). Rendering,
  transcoding and previews are out of scope.

---

## 3. Schema

Two tables, in the shape the existing overlay already uses: one current-state
row and one append-only journal. Naming, `business_id` + `business_ref_id`
pairing, `state_version` optimistic concurrency and `ON DELETE CASCADE` follow
`decision_workflow_state` exactly, so the operational habits (backfill, restore,
retention) transfer without a second set of rules.

```sql
CREATE TABLE IF NOT EXISTS creative_workflow_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           TEXT NOT NULL,
  business_ref_id       UUID REFERENCES businesses(id) ON DELETE CASCADE,
  -- The account this request belongs to. NOT NULL on purpose: a card whose
  -- account is unknown is exactly the card the Inbox already withholds today
  -- ("withheld because provider account identity is missing"), and a nullable
  -- column would let it be shown instead.
  provider              TEXT NOT NULL DEFAULT 'meta',
  provider_account_id   TEXT NOT NULL,

  title                 TEXT NOT NULL,
  brief                 TEXT,
  status                TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                          'requested','in_production','delivered','live',
                          'cancelled'
                        )),
  -- Why it is not in a column any more. Required for the two terminal-ish
  -- statuses so "cancelled" is never a silent disappearance.
  status_reason         TEXT,

  owner_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  due_at                TIMESTAMPTZ,

  -- Decision lineage: a CITATION, never authority. See §7.
  source_decision_key   TEXT,
  source_decision_snapshot_at TIMESTAMPTZ,
  source_engine_version TEXT,

  -- What actually shipped, once something did.
  live_ad_id            TEXT,
  live_verified_at      TIMESTAMPTZ,

  status_version        INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_workflow_items_board
  ON creative_workflow_items (business_id, provider_account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_workflow_items_owner
  ON creative_workflow_items (owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_creative_workflow_items_due
  ON creative_workflow_items (business_id, due_at)
  WHERE due_at IS NOT NULL AND status IN ('requested','in_production');

CREATE TABLE IF NOT EXISTS creative_workflow_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id            UUID NOT NULL REFERENCES creative_workflow_items(id) ON DELETE CASCADE,
  version_number     INTEGER NOT NULL,
  storage_key        TEXT NOT NULL,      -- object-store key, not a URL
  content_sha256     TEXT NOT NULL,
  byte_size          BIGINT NOT NULL,
  mime_type          TEXT NOT NULL,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  approval_state     TEXT NOT NULL DEFAULT 'pending' CHECK (approval_state IN (
                       'pending','approved','changes_requested'
                     )),
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at        TIMESTAMPTZ,
  approval_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, version_number),
  UNIQUE (item_id, content_sha256)
);

-- Append-only. Rolling the feature back hides the board; it never destroys the
-- record of what people did. Same law as decision_workflow_events.
CREATE TABLE IF NOT EXISTS creative_workflow_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        TEXT NOT NULL,
  item_id            UUID NOT NULL,
  event              TEXT NOT NULL,
  from_status        TEXT,
  to_status          TEXT,
  owner_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  version_number     INTEGER,
  reason_code        TEXT,
  comment            TEXT,
  actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  status_version     INTEGER NOT NULL,
  idempotency_key    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_workflow_events_item
  ON creative_workflow_events (business_id, item_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_workflow_events_idem
  ON creative_workflow_events (business_id, item_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

`item_id` in the event journal is deliberately **not** a foreign key: the
journal must survive the deletion of the item it describes, exactly as the
decision journal survives a decision leaving the queue.

## 4. Status lifecycle

```
requested ──assign/start──> in_production ──upload+approve──> delivered ──verify──> live
    │                            │                                │
    └────────────cancel──────────┴────────────cancel──────────────┘
                                 ▲                                │
                                 └──────request_changes───────────┘
```

Transitions, and the rule that makes each one honest:

| Action | From → To | Guard |
| --- | --- | --- |
| `create` | — → `requested` | Requires business + assigned `provider_account_id` (§9). |
| `assign` | any non-terminal | Owner must be an active member of this business. |
| `start` | `requested` → `in_production` | Owner required — "in production" with nobody producing is a false column. |
| `deliver` | `in_production` → `delivered` | At least one version row with `approval_state='approved'`. Approval is what "delivered" MEANS; without it the card stays in production. |
| `request_changes` | `delivered` → `in_production` | Records `approval_state='changes_requested'` on the named version. |
| `mark_live` | `delivered` → `live` | Requires `live_ad_id` **and** a fresh exact provider GET proving that ad exists in this assigned account (§8). |
| `cancel` | any non-`live` → `cancelled` | `status_reason` required. |
| `reopen` | `cancelled` → `requested` | New `status_version`; the journal keeps both. |

Every transition is optimistic-concurrency checked against the
`status_version` the actor was looking at, and every one writes exactly one
`creative_workflow_events` row. This mirrors `WorkflowTransitionInput`'s
`expectedVersion` in `lib/decision-workflow.ts`, which already has the
"two operators, one card" case solved.

**No status is derived.** A card sits in the column its stored `status` names.
Inferring "delivered" from the presence of a file, or "live" from a creative
appearing in the warehouse, would manufacture workflow state out of measurement
— which is the specific dishonesty the current Inbox message exists to avoid.

## 5. Owner and dueAt

`owner_user_id` references `users(id)` with `ON DELETE SET NULL`: a departed
colleague leaves the card ownerless and visible, not deleted. The board shows an
ownerless card as ownerless; it never re-assigns one automatically.

`due_at` is `TIMESTAMPTZ`. It is rendered in the **workspace** timezone, on the
same clock the shell's date control resolves "today" against
(`components/layout/v2/app-topbar.tsx` reads the business timezone; see also
`lib/dashboard/date-window-url.ts`'s completed-day rule). An overdue card is
overdue on the workspace's calendar, not the viewer's browser's. A missing
`due_at` renders as an em dash — never as "today", never as "overdue".

## 6. File and version storage

- The database stores a **pointer**: `storage_key`, `content_sha256`,
  `byte_size`, `mime_type`. Bytes live in object storage. No base64 blobs in
  Postgres, and no public URL is persisted, because a persisted URL outlives the
  ACL that made it safe.
- `UNIQUE (item_id, content_sha256)` makes a re-upload of identical bytes a
  no-op rather than a phantom "version 4".
- `version_number` is allocated inside the same transaction as the row insert;
  there is no client-supplied version.
- Reads are served through a short-lived signed URL minted per request, after
  the same business + assigned-account re-check the item itself passes.
- Until the object-store binding exists, the Inbox's `onBrowseFiles` stays
  **undefined**, which is what keeps "Browse files" visibly disabled and blocks a
  local-only success path. That is the current behaviour and it is correct.

## 7. Decision lineage

`source_decision_key`, `source_decision_snapshot_at` and `source_engine_version`
record *which recommendation prompted this request*, as a citation and nothing
more:

- A workflow item may exist with **no** decision at all (an operator can just
  ask for a creative).
- A decision that is blocked, held, review-only or action-ineligible may still
  be cited. It may **not** thereby become executable — the Launchpad mapping law
  is unchanged, and in particular a held Cut labelled `test_more` never becomes
  a Fresh Test because someone made a card about it.
- The snapshot time and engine version are stored so the card can say *"raised
  from the decision as it stood on 2026-08-11, engine v3.4"*. A decision that
  has since changed does not silently rewrite the card's history.

## 8. Launchpad handoff

The handoff already has a contract: `lib/meta/launchpad-handoff-contract.ts` —
kind `meta_launchpad_decision_handoff`, envelope version `v1`, modes
`rebuild | duplicate | copy_draft`, TTLs of 15 minutes (handoff) and 30 minutes
(prefill), and a typed refusal list. This proposal **adds nothing** to it.

- **Out of the board:** a `delivered` card may open Launchpad with the existing
  envelope. The envelope is built by the existing server-side source, subject to
  the existing refusals and the existing caps (at most 20 creatives, 10 ad sets
  or targets, 20 planned provider creates). A workflow card is not an origin
  contract and does not raise any cap.
- **Back into the board:** Launchpad reporting a completed create is what
  supplies `live_ad_id`. `mark_live` then requires a **fresh exact provider GET**
  for that ad id in this assigned account before the card may move. Warehouse
  rows and returned payloads are discovery evidence only — a card that says
  "Live" on the strength of a POST response is a card asserting something nobody
  verified.
- A workflow item is never itself a write authority. It records that a write
  happened; it never causes one.

## 9. Role, demo and mobile authority

- **Assignment scoping.** Every read and write resolves `provider_account_id`
  through `resolveProviderAccountId` first. A URL is never authority: an id in a
  query is a request that the server intersects with this workspace's
  assignments, and an unassigned id is refused rather than widened.
- **Roles.** `guest` reads the board. `member` creates, assigns, uploads and
  moves cards. `admin` additionally cancels and reopens. `reviewerReadOnly`
  actors read only — every mutating control renders disabled, not hidden, so the
  operator can see what they lack rather than wondering where it went.
- **Demo.** Demo workspaces get a read-only board over a fixture partitioned by
  the demo workspace's own assigned account list (`getDemoMetaStatus()`), and
  **zero** write authority — no create, no upload, no transition, and no
  Launchpad handoff. "Demo businesses have zero Meta write authority even if a
  presentation defect supplies an action" applies here in full: a demo card that
  offers `mark_live` is a defect, not a feature.
- **Mobile.** The board is readable at every breakpoint; below the tablet
  breakpoint the columns scroll horizontally rather than collapsing. Mobile
  carries no reduced authority of its own — a viewport is not a permission — but
  destructive transitions (`cancel`) require the same explicit confirmation
  everywhere.

## 10. Audit events

`creative_workflow_events` is the record of intent and outcome. It is
append-only, it is written in the same transaction as the state change, and it
is never updated or deleted by application code. `idempotency_key` with a
partial unique index makes a retried request a no-op instead of a second
journal entry — the same additive idempotency the decision overlay already uses.

It does **not** replace the platform audit trail: provider mutations continue to
be recorded where they already are (`meta_ads_action_mutation_attempt_events`,
`meta_ads_action_reconciliation_events`), and administrative actions in
`admin_audit_logs`. A workflow event says "an operator moved a card"; it never
stands in for evidence that a provider did anything.

## 11. Migrations and rollback

**Forward.** One additive migration in `lib/migrations.ts`, following the
established form: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`,
each statement independently applied, no destructive DDL, no data backfill (there
is no prior data — this is the first workflow store in the product). It must be
proven on **both** seams that already exist and are non-negotiable:

- **from-zero**: `npm run test:migrations-from-zero`
- **upgrade**: the staged-worker / DR-restore stages of
  `scripts/verify-database-seams.sh`, which `.github/workflows/ci.yml:107`
  invokes.

New tests must be wired into that script — a seam test that only runs when
someone remembers it is not a seam test. Every DB test in this repo gates on
`ADSECUTE_EPHEMERAL_DB_SEAM=1` and runs against an ephemeral Postgres with a
fake provider; **a test that SKIPS is not a pass.**

**Rollback.** Two levels, and the distinction matters:

1. *Product rollback* — stop mounting the board and the routes. The tables stay.
   The Inbox returns to the honest unavailable state it is in today, and no
   operator record is destroyed. This is the default and it is reversible.
2. *Schema rollback* — `DROP TABLE`. Only ever with the journal exported first,
   because dropping `creative_workflow_events` destroys the record of what
   people decided. Given the row volumes involved, the correct answer is almost
   always (1); (2) exists for a failed rollout in the first hours, not as a
   maintenance tool.

There is no feature flag. This product ships a merge; the rollback story above is
what stands in for a flag, and it is why the journal is append-only.

## 12. What has to be true before any of this is built

1. This ADR is accepted.
2. An object-store binding exists, with signed-read minting and a retention
   policy — otherwise §6 is a hole and "Delivered" cannot mean anything.
3. The seam tests in §11 exist and RUN (not skip) in
   `scripts/verify-database-seams.sh`.
4. The Inbox surface change is spec'd against the canonical reference the same
   way ITEM 18 was: quote the design for the card, the column and the controls
   before building them.

Until all four hold, the Inbox stays exactly as it is: four drawn columns, no
cards, and a sentence that says the columns are unavailable rather than empty.
