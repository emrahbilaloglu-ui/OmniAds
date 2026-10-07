# Finite native storage operator runbook (D149)

This is a manual operator procedure for the existing finite entrypoints in
`scripts/native-storage-batch/cli.ts`.

- **Not a scheduler.** It installs no scheduler, cron, timer or unattended job.
- **No automatic actions.** It never deletes, activates a root, or retires
  without the Chrome-authenticated serving proof.
- **Not a throughput claim.** The eight-generation / 1,134-evaluation /
  four-context / 9,072-evaluation limits are safety bounds. A cycle cadence is
  not a measured storage rate, and running more often is not shown to be
  sufficient.

## Standing rules

- **One root.** Use exactly one declared private production operator state
  root, the `stateRoot` of the reviewed host config. The D149 lease is local
  to that root. It does not lock the database or another machine, so never
  operate a second state root against the same production host.
- **One purpose at a time.** Never run purposes in parallel.
- **No reuse.** A consumed, abandoned or released purpose is never planned,
  executed or resumed again.
- **No replays or bypasses.** Never replay fb9, FULL or REINDEX. Never raise
  the budget, never set an override, and never bypass a physical floor or
  admission refusal.
- **Unknown means status only.** Ambiguous or unknown results are read-only
  status. Never retry them, re-dispatch them, or use them as a reason to
  abandon.

## 0. Before the first owned cycle (once)

1. **Review and pins.** Have the exact-source review and source pack for the
   committed operator revision, with the live runtime revision pinned
   separately. Then take a fresh `production-prestate` and pin the host config.
2. **Read the root's state.** Run
   `cli.ts owner-status --host <production-host.json>` (read-only).
3. **Resolve every listed purpose.** Each must be `released:*` or resolved
   here:
   - **fb9-shaped** (`maintenance-ack-unknown`: every retirement and readback
     acknowledged, lost post-retirement maintenance ACK): run
     `cli.ts dispose-maintenance-unknown --host … --purpose <p> --pg-host <socket dir|loopback> --pg-port <n> --pg-database <db> --pg-user <role>`.
     - **Connection.** One READ ONLY connection that the root operator
       already holds (for example a loopback forward); no password argument.
       The role must be superuser or a member of `pg_read_all_stats`, and able
       to read the retained tables.
     - **What the command proves live:** the purpose/plan/journal/marker/stage
       binding; each retired unit absent with byte-equal roots; full backend
       visibility; no operator, maintenance or locking backend on the
       targets.
     - **Refusals.** Any refusal means stop and keep status read-only, never
       retry the original SQL.
     - **Result.** It records an UNKNOWN terminal outcome: never success,
       never a retry permission.
   - **5aa1-shaped** (consumed; verified journal exactly begin + finish; actual
     exit 1, not status-only; nothing retired; no execution artifact): run
     `cli.ts dispose-pre-dispatch-refused --host … --purpose <p>`. It records
     `terminal-pre-dispatch-refused` and preserves every original byte. The
     plan is never resumed or adopted.
   - **Expired capture-only** (`resumable`; verified journal exactly begin,
     one acknowledged `capture-restore` intent/receipt per planned unit, and a
     finish refused at `publish` before its intent; no publish, activate,
     retire, maintenance or HTTP artifact):
     - **Wait.** Wait until the ORIGINAL 30-minute window from the journal
       begin has passed. Never reset it.
     - **Never resume it.** After expiry a resume only appends
       `resume`/`finish` records. The purpose then no longer has this shape
       and stays blocked.
     - **Dispose.** Run
       `cli.ts dispose-expired-capture-only --host … --purpose <p>`.
     - **What it records.** `terminal-expired-capture-only`: no success, no
       retry, no reclaim and no chain advance. The journal, marker, plan, both
       private copies and the restore records stay byte-identical.
     - **Captured units are not skipped.** The next purpose starts at the
       unchanged frontier and examines them again.
   - **`planned` or `unknown` with no journal** (for example an older
     `NO_ELIGIBLE` plan directory): run `cli.ts abandon --host … --purpose <p>`.
     This is allowed only while no owner is active and no lease named the
     purpose.
   - **Anything else** (`resumable` with any other action, `running`, `ambiguous`,
     `ambiguous-routing`), or any `*_RECORD_INVALID` / `PURPOSE_MARKER_INVALID`
     refusal: stop. Corrupt metadata is never repaired by hand into a release.

## 1. Read-only trigger (never starts work)

Read the existing growth-fence decision and the physical capacity snapshot.
Do not change them.

- **Stop:**
  - an override is set;
  - the database budget differs from the actual unchanged business budget
    (163 GiB);
  - the physical floor refuses;
  - any measurement is missing, stale or unknown.
- **Margin below 512 MiB:** write the high-water report.
- **Margin below 1 GiB:** prepare the next purpose (step 2).
- **Otherwise:** no action.

## 2. One chained cycle

1. **Check the owner and pin the host.** Run `owner-status`. `owner` must be
   `null`; note `frontier`. Take a fresh `production-prestate` and pin it in
   the host config: a previous purpose's activation recreated web.
2. **Plan.** Run
   `cli.ts plan --host … --purpose <new 12hex> --cutoff <iso> --review … --limit <≤64> [--max-units n] [--cursor <frontier.asOfDate>:<frontier.jobRunId>] --arm-production-transport <same purpose>`.
   - Omit `--cursor` only when `frontier` is `null`. A missing, ahead or
     behind cursor refuses.
   - Inspect the output and `batches/<p>/examined.json`: `examinedThrough`,
     `breakCandidate` (examined again by the next purpose, never skipped) and
     `transientVetoes`.
   - **`terminalScan: true`** (empty or all-veto window): the purpose is
     already released as a read-only terminal scan. Stop here or plan the next
     window.
   - **Refused after it took the lease** (no journal yet): run `abandon` on
     that purpose before anything else.
3. **Execute.** Run `cli.ts execute … --arm-production-transport <p>`. It
   pauses (`PAUSE-<job>.json`) at the authenticated serving gate after
   activation.
4. **Prove serving.** For every retired unit, perform the Chrome-authenticated
   HTTP serving proof as before. No proof means no retirement.
5. **Resume.** Run `cli.ts resume …` with the same purpose: same plan, same
   original 30-minute start. Exit 0 writes the `finished` release. Any other
   end is read-only status; follow the standing rules.
   - **Never after expiry.** Never resume after the original 30-minute window.
     An expired purpose that only captured is closed by
     `dispose-expired-capture-only` (step 0.3).
6. **Measure.** Take a matched-interval measurement with the existing
   read-only census over equal intervals before and after:
   - raw database bytes;
   - per-table main, TOAST and index bytes;
   - insert/update/delete counters;
   - (auto)vacuum timestamps.

   Retirement makes space reusable; it is not an OS shrink.

Archive-engine vetoes (`ARCHIVE_ENGINE_UNSUPPORTED`,
`ARCHIVE_ENGINE_METADATA_UNKNOWN`) are settled header dispositions: the window
records them and the frontier moves past them.
- **No freeze.** Such a header is never frozen.
- **Diagnosis.** Read its engine from the plan output's candidate generation,
  never from the code.
- **Not a failure verdict.** They are not product, data or firm failures, and
  they never authorize an adapter, synthesized evidence or a SQL engine filter.

## 3. Transient-veto revisit (explicit and bounded)

Transient vetoes (for example `SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED`) and
generations that became selectable behind the frontier are reached only by an
explicit revisit:

`plan … --cursor <c strictly behind frontier> --revisit true`

- **One window.** One selection window of at most 64 rows, recorded in the
  lease and the examined record.
- **No regression.** The frontier never moves backwards.
- **Same cycle rules.** A revisit is an ordinary purpose otherwise (single
  owner, steps 2.3–2.6).
