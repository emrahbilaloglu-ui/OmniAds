import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Scope = typeof import("./db-jit-scope");

/** Separate compiled copies, as emitted for the two production route graphs. */
function loadScopeCopy(): Scope {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/db-jit-scope.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: createRequire(import.meta.url),
    globalThis,
  }, { timeout: 1_000 });
  return exports as Scope;
}

describe("database JIT scope across compiled module copies", () => {
  it("lets either copy's cached executor observe the other copy's request", async () => {
    const a = loadScopeCopy();
    const b = loadScopeCopy();
    expect([a.isDbJitDisabledInScope(), b.isDbJitDisabledInScope()]).toEqual([false, false]);
    await a.runWithDbJitDisabled(async () => {
      await Promise.resolve();
      expect([a.isDbJitDisabledInScope(), b.isDbJitDisabledInScope()]).toEqual([true, true]);
    });
    await b.runWithDbJitDisabled(async () => {
      expect([a.isDbJitDisabledInScope(), b.isDbJitDisabledInScope()]).toEqual([true, true]);
    });
    expect([a.isDbJitDisabledInScope(), b.isDbJitDisabledInScope()]).toEqual([false, false]);
  });

  it("keeps an unrelated concurrent request unscoped", async () => {
    const a = loadScopeCopy();
    const b = loadScopeCopy();
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const scoped = a.runWithDbJitDisabled(async () => {
      started();
      await barrier;
      expect(b.isDbJitDisabledInScope()).toBe(true);
    });
    await ready;
    try {
      expect(a.isDbJitDisabledInScope()).toBe(false);
      expect(b.isDbJitDisabledInScope()).toBe(false);
    } finally {
      release();
    }
    await scoped;
    expect(b.isDbJitDisabledInScope()).toBe(false);
  });

  it("restores the outer request after a nested rejection", async () => {
    const a = loadScopeCopy();
    const b = loadScopeCopy();
    await expect(a.runWithDbJitDisabled(async () => {
      await b.runWithDbJitDisabled(async () => {
        expect(a.isDbJitDisabledInScope()).toBe(true);
        throw new Error("owned-scope-test");
      });
    })).rejects.toThrow("owned-scope-test");
    expect([a.isDbJitDisabledInScope(), b.isDbJitDisabledInScope()]).toEqual([false, false]);
  });
});
