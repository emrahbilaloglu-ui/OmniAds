import { describe,expect,it } from "vitest";
import { privateRestoreDatabaseName,privateRestoreUrl,validatePrivateRestoreUrl } from "./private-restore";
describe("private restore target boundary",()=>{
  it("binds only the fixed isolated socket/role/port and a generated owned database",()=>{
    const name=privateRestoreDatabaseName("a".repeat(12)),url=privateRestoreUrl(name);
    expect(()=>validatePrivateRestoreUrl(url,name)).not.toThrow();
    for(const changed of [url.replace("localhost","87.99.149.56"),url.replace("25432","5432"),
      url.replace("native_restore@","postgres@"),url+"&sslmode=disable",url.replace("nc_restore_", "adsecute_prod_")])
      expect(()=>validatePrivateRestoreUrl(changed,name)).toThrow();
    expect(()=>privateRestoreUrl("adsecute_prod")).toThrow();
    expect(()=>privateRestoreDatabaseName("../anything")).toThrow();
  });
});
