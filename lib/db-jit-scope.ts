import { AsyncLocalStorage } from "node:async_hooks";

/*
  A per-async-context request to run database statements without LLVM JIT.

  The creative decision reads (D101 source coverage, D105 knowledge cutoffs,
  D106 member status) are very large generated statements. On real data their
  planner estimate crosses jit_optimize_above_cost while their actual work is
  sub-second, so every execution pays LLVM compilation: on the Ubuntu
  PostgreSQL 16 build used in production and CI one such statement measured
  316 ms with jit=off against 7.3 s with jit=on.

  The request is scoped rather than set on the whole pool so that unrelated
  reads -- reporting and analytics scans that may genuinely benefit from JIT --
  keep the server's setting. `lib/db.ts` honours it on both paths: a pooled
  statement sets and resets `jit` on its leased connection, and a statement
  inside `runDbTransaction` uses `SET LOCAL`, which ends with the transaction.

  This lives outside `lib/db.ts` on purpose: modules that mock `@/lib/db` in
  tests still get the real scope, so callers need no test-side stubs.
*/
const dbJitDisabledScope = new AsyncLocalStorage<true>();

export function runWithDbJitDisabled<T>(fn: () => Promise<T>): Promise<T> {
  return dbJitDisabledScope.run(true, fn);
}

export function isDbJitDisabledInScope(): boolean {
  return dbJitDisabledScope.getStore() === true;
}
