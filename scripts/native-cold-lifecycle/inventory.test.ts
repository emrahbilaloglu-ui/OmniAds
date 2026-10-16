import { readFile } from "node:fs/promises";
import { expect,it } from "vitest";
import { buildColdSourceInventory,COLD_INVENTORY_PATH } from "./inventory";
it("ships the actual reviewed worker, host installer, erasure, source and HTTP boundary bytes",async()=>{
  const actual=await buildColdSourceInventory(),frozen=JSON.parse(await readFile(COLD_INVENTORY_PATH,"utf8"));
  expect(actual).toEqual(frozen);
  for(const path of ["scripts/native-cold-lifecycle/controller.ts","scripts/native-cold-lifecycle/gate.ts",
    "scripts/native-cold-lifecycle/install-app.py","scripts/native-cold-lifecycle/install-db.py",
    "scripts/native-cold-lifecycle/http.ts","lib/native-cold-erasure.ts","lib/business-deletion.ts","Dockerfile"])
    expect(frozen.files.some((e:{path:string})=>e.path===path)).toBe(true);
});
