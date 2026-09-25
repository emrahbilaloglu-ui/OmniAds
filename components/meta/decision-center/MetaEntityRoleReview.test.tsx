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

describe("Meta entity role review", () => {
  it("keeps a parent Main role as a suggestion for an undeclared ad set and writes only the operator-selected Test exception", async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, declarations: [{ id: "saved-1", entityType: "adset", entityId: "456", event: "declare", declaredRole: "test" }] }),
    });
    const get = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, declarations: [{ id: "saved-1", entityType: "adset", entityId: "456", event: "declare", declaredRole: "test" }] }),
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? post(url, init) : get(url, init));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} decisionAsOf={yesterday} readOnly={false} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    expect(screen.getByText("Unverified · parent suggests MAIN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm selected roles" }).hasAttribute("disabled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm selected roles" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = JSON.parse((post.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.businessId).toBe("biz-1");
    expect(body.providerAccountId).toBe("act_1");
    expect(body.declarations).toEqual([
      expect.objectContaining({ entityType: "adset", entityId: "456", event: "declare", role: "test", effectiveFrom: yesterday }),
    ]);
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not offer a write to a read-only viewer", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    expect(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }).hasAttribute("disabled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
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
    vi.stubGlobal("fetch", vi.fn((_: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, declarations: [{
        id: "saved-1", entityType: "adset", entityId: "456", event: "declare", declaredRole: "test",
      }] }),
    })));
    render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly={false} onSaved={() => Promise.reject(new Error("refresh failed"))} />);
    fireEvent.click(screen.getByRole("button", { name: /Review Main \/ Test roles/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Confirm role for adset Test cell" }), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm selected roles" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 role confirmed"));
    expect(screen.getByRole("status").textContent).toContain("The screen did not refresh");
  });
});
