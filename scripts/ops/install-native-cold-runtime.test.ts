import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect,it } from "vitest";
it("verifies the actual immutable runtime/source/mount/key boundaries without relying on a frozen host checkout",()=>{
  expect(execFileSync("python3",[resolve("scripts/ops/install-native-cold-runtime-test.py")],{
    encoding:"utf8",timeout:15000,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},
  })).toBe("");
});
