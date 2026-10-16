import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect,it } from "vitest";

it("executes the actual restricted mirror and replica protocol on separate owned filesystem roots",()=>{
  const result=execFileSync("python3",[resolve("scripts/native-cold-lifecycle/mirror-protocol-test.py")],
    {encoding:"utf8",timeout:15_000,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
  expect(result).toBe("");
});
