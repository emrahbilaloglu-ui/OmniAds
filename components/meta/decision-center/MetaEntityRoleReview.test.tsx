// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaOsStructureGroup, MetaOsStructureNode } from "@/lib/meta/decisions-os-contract";
import { MetaEntityRoleReview } from "./MetaEntityRoleReview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(level: "campaign" | "adset", id: string, role: "main" | "test", confirmed = false) {
  return {
    level,
    providerEntityId: id,
    id: `${level}:${id}`,
    campaignId: level === "campaign" ? id : "123",
    name: level === "campaign" ? "Main campaign" : "Test cell",
    lifecycleRole: role,
    roleBasis: confirmed ? "declared" : "parent_campaign_suggestion",
    campaignRoleTrustedForAction: confirmed,
  } as MetaOsStructureNode;
}

const groups = [{
  campaign: node("campaign", "123", "main", true),
  adsets: [node("adset", "456", "main")],
}] as MetaOsStructureGroup[];

const savedTestRole = {
  id: "saved-1", entityType: "adset", entityId: "456",
  parentCampaignId: "123", event: "declare", declaredRole: "test",
  effectiveFrom: new Date().toISOString().slice(0, 10),
  declaredAt: new Date().toISOString(),
  contractVersion: "meta-entity-role-declaration.v1",
};

describe("Meta entity role review", () => {
  it("keeps a parent Main role as a suggestion for an undeclared ad set and writes only the operator-selected Test exception", async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, declarations: [savedTestRole] }),
    });
    let saved = false;
    const get = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ ok: true, declarations: saved ? [savedTestRole] : [] }),
    }));
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        saved = true;
        return post(url, init);
      }
      return get(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} decisionAsOf={yesterday} readOnly={false} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    expect(screen.getByText("Unverified · parent suggests MAIN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm selected roles" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(get).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm selected roles" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = JSON.parse((post.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.businessId).toBe("biz-1");
    expect(body.providerAccountId).toBe("act_1");
    expect(body.declarations).toEqual([
      expect.objectContaining({ entityType: "adset", entityId: "456", event: "declare", role: "test", effectiveFrom: yesterday }),
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Confirmed TEST · pending decision run")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review Main \/ Test roles/i }).textContent).toContain("0 unverified");
  });

  it("does not offer a write to a read-only viewer", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, declarations: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    expect(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }).hasAttribute("disabled")).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("does not call a confirmed role unverified just because an older verdict remains held", () => {
    const confirmedAdset = {
      ...node("adset", "456", "test", true),
      campaignRoleTrustedForAction: false,
    } as MetaOsStructureNode;
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={[{
      ...groups[0]!, adsets: [confirmedAdset],
    }]} readOnly onSaved={() => {}} />);
    expect(screen.getByRole("button", { name: /Review Main \/ Test roles/i }).textContent).toContain("0 unverified");
  });

  it("keeps a verified write confirmed when the subsequent screen refresh fails", async () => {
    let saved = false;
    vi.stubGlobal("fetch", vi.fn((_: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, declarations: init?.method === "POST" || saved ? [savedTestRole] : [] }),
    })));
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly={false} onSaved={() => Promise.reject(new Error("refresh failed"))} />);
    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }), { target: { value: "test" } });
    saved = true;
    fireEvent.click(screen.getByRole("button", { name: "Confirm selected roles" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 role confirmed"));
    expect(screen.getByRole("status").textContent).toContain("The screen did not refresh");
    expect(screen.getByText("Confirmed TEST · pending decision run")).toBeTruthy();
  });

  it("does not show an ad set declaration from a different parent campaign as confirmed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, declarations: [
        { ...savedTestRole, id: "old", declaredAt: "2026-09-24T10:00:00.000Z" },
        { ...savedTestRole, id: "new", parentCampaignId: "999", declaredAt: "2026-09-25T10:00:00.000Z" },
      ] }),
    }));
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    await waitFor(() => expect(screen.getByText("Declaration belongs to another campaign · unverified")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Review Main \/ Test roles/i }).textContent).toContain("1 unverified");
  });
});
