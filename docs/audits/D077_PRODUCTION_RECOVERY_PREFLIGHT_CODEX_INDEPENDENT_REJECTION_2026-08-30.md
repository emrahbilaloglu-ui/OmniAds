# D077 production-recovery preflight — Codex independent rejection (2026-08-30)

Decision: **REJECT the submitted artifact package.** This is not permission to
deploy or mutate production. The conservative operational conclusions remain
unchanged: release/deploy is `NO_GO`; D077 execute is sequence-blocked; no valid
production plan exists; plan hash, removable rows, and protection totals remain
`UNKNOWN` rather than zero.

## Acceptance blockers

1. **The frozen source identity is contradictory.** The release packet and
   report describe 265 candidate files, while the final manifest contains 271
   entries. The manifest says it excludes itself but includes itself with a
   stale per-file SHA (`154b6088…` versus the actual `e24df3ec…`). A manifest
   cannot recursively pin its own final bytes. Regenerate it last, exclude its
   own path explicitly, and state separately: Git porcelain count, expanded
   file count, pinned non-self count, and final external manifest file SHA.

2. **Planner termination provenance is wrong.** The 300-second attempt timed
   out. The long no-output planner processes were terminated by the Codex
   supervisor after bounded waiting to avoid indefinite production read load;
   the final planner process received SIGINT. They were not proven to have been
   killed by a sandbox reaper. No plan file was produced and no production
   write occurred. Correct the report, evidence artifact, and DB packet. Also
   record that Codex terminated one task-owned orphaned `sleep 900` timeout
   watcher after the local cutover harness had finished and the watcher alone
   held the output pipe open; this did not alter the test or DB result.

3. **The serving-direct production read does not satisfy the prompt's SQL
   evidence contract.** `scripts/verify-serving-direct-release.ts` calls
   `readServingFreshnessStatus` without one explicit, proved
   `REPEATABLE READ READ ONLY` transaction and rollback. Its production-tunnel
   results therefore cannot be called verified production facts or a verified
   third release blocker. Re-run those reads under the same bounded RR/RO,
   unique-application-name, in-transaction proof, rollback contract, or
   downgrade/remove them. The two local battery failures independently keep
   release `NO_GO` meanwhile.

4. **The evidence file is not reproducible from its collector.** The collector
   emits and hashes only the core SQL payload, while the submitted JSON also
   contains manually appended out-of-transaction, planner, and evidence-class
   sections. Make one deterministic generator/postprocessor own the final
   shape. Every embedded hash must declare the exact byte algorithm and hash
   basis and must be independently recomputable. Generate evidence, packets,
   and report before generating the non-self manifest; do not modify a pinned
   file afterward.

5. **The release packet is stale relative to the final tree.** Its 265-file
   counts and class totals refer to the pre-task freeze, its timestamp predates
   the completed test battery, and it points at a different manifest scope.
   Reissue it against the final corrected tree while preserving `NO_GO` until
   every named blocker is actually cleared.

6. **Required verification provenance is incomplete.** Add a machine-readable
   ledger with the exact command, tool/runtime versions, start/end timestamps,
   exit code, pass/fail/skip counts, timeout, teardown, and equivalence mapping
   for every canonical stage. The current prose counts do not meet that
   requirement. Fix the pnpm/npm-independent Vitest invocation in the
   launchpad-handoff seam and run the real canonical seam rather than retaining
   an environment-blocked wrapper plus an ad-hoc equivalent.

7. **The two red tests need bounded corrections, not weakened authority.** The
   static 410 `meta/campaign-labels` tombstone reads/writes no tenant data and
   should be explicitly classified in the route-authority guard with its
   compatibility reason. The duplicate-preselection fixture replaces the full
   `sourceAuthority` object but omits
   `executionReadiness: "live_preflight_required"`; prove the exact refusal,
   repair the stale fixture if confirmed, and never reintroduce manual label
   authority or weaken runtime gates.

8. **Coverage checksum and data-quality verdict are missing.** Add an explicit
   checksum algorithm and value. Independent reconciliation of the seven
   sorted `businessId|providerAccountId` lines, LF-joined with no trailing LF,
   yields SHA-256
   `18ea0e86085f2086d4d113a9239af9439648a2cec4aecd9907262ef2fff7fc39`.
   State separately that the evidence is sufficient for recovery/readiness
   preflight but insufficient for decision-effect, outcome, or causal claims:
   the six-business outcome lane contains zero rows.

9. **Several evidence labels are too strong.** `pg_stat_user_tables.n_live_tup`
   and `n_dead_tup` are estimates, not exact row counts. Automation's effective
   fail-closed posture is supported by one engaged stop plus five missing rows,
   but deployed environment internals were not read. Capture
   `auto_execution_enabled`, `readiness_tier`, and the effective control result;
   phrase host environment state as an explicit precondition/unknown rather
   than an absolute read-back.

10. **The pgstattuple action is under-specified.** `rolsuper=false` alone is not
    the full installation proof. Capture the selected extension version's
    `trusted` flag, current-database `CREATE` privilege, and the actual required
    installer role. More importantly, installation alone does not prove the app
    can call `pgstattuple_approx`: capture membership/EXECUTE capability for
    `pg_stat_scan_tables` or the function and add an explicit, least-privilege,
    reversible grant step if needed. Without function execution, the fence
    falls back to raw bytes and ingestion remains refused.

## Checks that passed

- The four JSON artifacts parse.
- File SHA-256 values reported in Claude's final response match current files.
- Apart from the manifest's impossible/stale self-entry, every manifest
  per-file hash independently checked matches the current file or a declared
  deletion.
- The core preflight collector structurally enforces a bounded transaction,
  in-transaction RR/RO proof, and rollback via sentinel; it contains no
  production write statement.
- Six unique businesses and seven unique account assignments reconcile across
  charter, clocks, assigned-account reads, generations, and DB-packet scope.
- No credential, DSN, session cookie, bearer token, or approval token was found
  in the six submitted files.
- No task-owned D077 planner/test process remains. The pre-existing SSH tunnel
  on `127.0.0.1:15432` remains listening and was not started or stopped by this
  work.

No correction package is accepted until Claude returns Final, becomes Idle,
and Codex independently verifies the corrected tree and artifacts.
