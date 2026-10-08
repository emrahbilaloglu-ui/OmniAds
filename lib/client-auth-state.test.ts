// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAuthenticatedWorkspace, removeBusinessClientState } from "./client-auth-state";
import { getAppQueryClient } from "./query-client";
import { useAppStore, type Business } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";

const first: Business = {id:"biz_1",name:"Removed",timezone:"UTC",currency:"USD"};
const other: Business = {id:"biz_10",name:"Preserved",timezone:"UTC",currency:"USD"};
const ownedKeys = ["adsecute_active_platform_biz_1", "creatives-briefing-selected:biz_1",
  "adsecute:overview-layout:v1:biz_1", "creative-studio:assets:v1:biz_1:account-a"];
const foreignKeys = ownedKeys.map(k=>k.replace("biz_1","biz_10"));
beforeEach(()=>{
  window.localStorage.clear();
  useAppStore.getState().setWorkspaceSnapshot("user_1",[first,other],first.id);
  useIntegrationsStore.getState().clearAllState();
  getAppQueryClient().clear();
  for(const key of [...ownedKeys,...foreignKeys])window.localStorage.setItem(key,"fixture");
  window.localStorage.setItem("creativesTableLayout","global");
  window.localStorage.setItem("adsecute:overview-layout:v1:unscoped","global-unscoped");
});
afterEach(()=>{vi.restoreAllMocks();getAppQueryClient().clear();window.localStorage.clear();});

describe("confirmed business browser erasure",()=>{
  it("removes the exact business preferences and cached reads while preserving similar foreign IDs and global preferences",()=>{
    getAppQueryClient().setQueryData(["decisions",first.id],{fixture:"old decision"});
    expect(removeBusinessClientState(first.id)).toBe(true);
    expect(useAppStore.getState().businesses).toEqual([other]);
    expect(useAppStore.getState().selectedBusinessId).toBe(other.id);
    expect(getAppQueryClient().getQueryData(["decisions",first.id])).toBeUndefined();
    for(const key of ownedKeys)expect(window.localStorage.getItem(key)).toBeNull();
    for(const key of foreignKeys)expect(window.localStorage.getItem(key)).toBe("fixture");
    expect(window.localStorage.getItem("creativesTableLayout")).toBe("global");
    expect(window.localStorage.getItem("adsecute:overview-layout:v1:unscoped")).toBe("global-unscoped");
  });

  it("heals an older browser from an authenticated authoritative membership list, without reviving cached deleted decisions",()=>{
    getAppQueryClient().setQueryData(["decisions",first.id],{fixture:"old decision"});
    applyAuthenticatedWorkspace({userId:"user_1",businesses:[other],activeBusinessId:other.id});
    for(const key of ownedKeys)expect(window.localStorage.getItem(key)).toBeNull();
    for(const key of foreignKeys)expect(window.localStorage.getItem(key)).toBe("fixture");
    expect(getAppQueryClient().getQueryData(["decisions",first.id])).toBeUndefined();
    expect(useAppStore.getState().businesses).toEqual([other]);
  });

  it("preserves the business preferences when the authoritative list still contains it",()=>{
    applyAuthenticatedWorkspace({userId:"user_1",businesses:[first,other],activeBusinessId:first.id});
    for(const key of [...ownedKeys,...foreignKeys])expect(window.localStorage.getItem(key)).toBe("fixture");
  });

  it("does not falsely confirm browser erasure when storage removal is refused",()=>{
    vi.spyOn(Storage.prototype,"removeItem").mockImplementation(()=>{throw new Error("storage unavailable");});
    expect(removeBusinessClientState(first.id)).toBe(false);
    expect(useAppStore.getState().businesses).toEqual([other]);
    for(const key of ownedKeys)expect(window.localStorage.getItem(key)).toBe("fixture");
  });
});
