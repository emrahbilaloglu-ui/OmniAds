// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { MetaOsStructureGroup, MetaOsStructureNode } from "@/lib/meta/decisions-os-contract";
import { MetaEntityRoleReview } from "./MetaEntityRoleReview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(level: "campaign" | "adset", id: string, role: "main" | "test", confirmed = false) {
  return {
    level, providerEntityId: id, id: `${level}:${id}`,
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

const today = new Date().toISOString().slice(0, 10);
const savedTestRole = {
  id: "saved-1", entityType: "adset", entityId: "456",
  parentCampaignId: "123" as string | null, event: "declare", declaredRole: "test" as string | null,
  effectiveFrom: today, declaredAt: new Date().toISOString(),
  contractVersion: "meta-entity-role-declaration.v1",
};
type HistoryEvent = typeof savedTestRole;
type Declaration = { entityType: string; entityId: string; event: string; role: string | null; effectiveFrom: string };

function server(initial: HistoryEvent[] = [], options: { failPost?: number; wrongParent?: boolean } = {}) {
  const history = [...initial];
  const posts: Array<{ businessId: string; providerAccountId: string; declarations: Declaration[] }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      posts.push(body);
      if (options.failPost === posts.length) throw new Error("Connection lost");
      const saved = body.declarations.map((item: Declaration, index: number) => ({
        ...savedTestRole, id: `saved-${posts.length}-${index}`,
        entityType: item.entityType, entityId: item.entityId,
        parentCampaignId: item.entityType === "adset" ? options.wrongParent ? "999" : "123" : null,
        event: item.event, declaredRole: item.role, effectiveFrom: item.effectiveFrom,
        declaredAt: new Date(Date.now() + posts.length).toISOString(),
      }));
      history.push(...saved);
      return { ok: true, status: 200, json: async () => ({ ok: true, declarations: saved }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, declarations: [...history] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { history, posts, fetchMock };
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: /Main \/ Test roles/ }));
  await waitFor(() => expect(screen.queryByText("Loading saved roles…")).toBeNull());
}
function chooseRole(role: "Main" | "Test", campaign = "Main campaign") {
  fireEvent.click(within(screen.getByRole("group", { name: `Default role for ${campaign}` })).getByRole("button", { name: role }));
}
function addException(id = "456", campaign = "Main campaign") {
  fireEvent.click(screen.getByRole("button", { name: `Exceptions for ${campaign}` }));
  fireEvent.change(screen.getByRole("combobox", { name: `Add exception to ${campaign}` }), { target: { value: `adset:${id}` } });
}
function confirm() { fireEvent.click(screen.getByRole("button", { name: "Confirm campaign roles" })); }
function review(props: Partial<React.ComponentProps<typeof MetaEntityRoleReview>> = {}) {
  render(<MetaEntityRoleReview businessId="biz-1" providerAccountId="act_1" groups={groups} readOnly={false} onSaved={() => {}} {...props} />);
}

describe("Campaign-first Main/Test review", () => {
  it("shows campaigns only and reveals only explicitly chosen ad set exceptions", async () => {
    const api = server();
    review();
    expect(screen.queryByRole("dialog")).toBeNull();
    await openReview();
    expect(screen.getAllByRole("group", { name: /^Default role/ })).toHaveLength(1);
    expect(screen.queryByText("Test cell")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("1 ad set needs confirmation")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
    addException();
    expect(screen.getByRole("group", { name: "Exception role for Test cell" })).toBeTruthy();
    expect(screen.getByText("Selected exception")).toBeTruthy();
    expect(api.posts).toHaveLength(0);
  });

  it("confirms a campaign and all its current children, using names only for the campaign suggestion", async () => {
    const api = server();
    const onSaved = vi.fn();
    review({ onSaved, groups: [{
      ...groups[0]!,
      campaign: { ...node("campaign", "123", "main"), name: "TS_MAIN_DPA" },
      adsets: [
        { ...node("adset", "456", "main"), name: "TS_TEST_ring" },
        { ...node("adset", "457", "main"), name: "Broad" },
        { ...node("adset", "458", "main"), name: "MAIN_TEST_conflict" },
      ],
    }] });
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Use 1 suggested role" }));
    expect(screen.getByText("Includes 3 current ad sets")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^Exception role/ })).toBeNull();
    expect(api.posts).toHaveLength(0);
    confirm();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.posts[0]).toMatchObject({ businessId: "biz-1", providerAccountId: "act_1" });
    expect(api.posts[0]!.declarations.map(({ entityType, entityId, role }) => [entityType, entityId, role])).toEqual([
      ["campaign", "123", "main"], ["adset", "456", "main"], ["adset", "457", "main"], ["adset", "458", "main"],
    ]);
    expect(api.fetchMock).toHaveBeenCalledTimes(3); // initial history, write, independent history readback
  });

  it("saves an explicitly chosen Test exception without rewriting the confirmed Main parent or unrelated ad sets", async () => {
    const api = server();
    const onSaved = vi.fn();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    review({ onSaved, decisionAsOf: yesterday, groups: [{ ...groups[0]!, adsets: [
      groups[0]!.adsets[0]!, { ...node("adset", "457", "main", true), name: "Other cell" },
    ] }] });
    await openReview();
    addException();
    confirm();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.posts[0]!.declarations).toEqual([
      expect.objectContaining({ entityType: "adset", entityId: "456", event: "declare", role: "test", effectiveFrom: yesterday }),
    ]);
    expect(screen.getByText("Saved exception")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Main \/ Test roles/, hidden: true })).toHaveTextContent("0 to review");
  });

  it("keeps saved exceptions during campaign confirmation and restores the campaign default on explicit request", async () => {
    const api = server([savedTestRole]);
    const onSaved = vi.fn();
    review({ onSaved, groups: [{ ...groups[0]!, adsets: [
      groups[0]!.adsets[0]!, { ...node("adset", "457", "main"), name: "New cell" },
    ] }] });
    await openReview();
    chooseRole("Main");
    confirm();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.posts[0]!.declarations).toEqual([
      expect.objectContaining({ entityId: "457", role: "main" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Exceptions for Main campaign" }));
    expect(screen.getByText("Saved exception")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use campaign role" }));
    expect(screen.queryByRole("group", { name: /^Exception role/ })).toBeNull();
    confirm();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.posts[1]!.declarations).toEqual([expect.objectContaining({ entityId: "456", role: "main" })]);
  });

  it("allows read-only users to inspect exceptions but never stage or submit changes", async () => {
    const api = server([savedTestRole]);
    review({ readOnly: true });
    await openReview();
    expect(within(screen.getByRole("group", { name: "Default role for Main campaign" })).getByRole("button", { name: "Main" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Exceptions for Main campaign" }));
    expect(screen.getByText("Saved exception")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use campaign role" })).toBeDisabled();
    confirm();
    expect(api.posts).toHaveLength(0);
  });

  it("rejects history and save readback bound to a different parent campaign", async () => {
    const api = server([{ ...savedTestRole, parentCampaignId: "999" }], { wrongParent: true });
    const onSaved = vi.fn();
    review({ onSaved });
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Exceptions for Main campaign" }));
    expect(screen.queryByText("Saved exception")).toBeNull();
    expect(screen.getByRole("button", { name: /Main \/ Test roles/, hidden: true })).toHaveTextContent("1 to review");
    chooseRole("Main");
    confirm();
    await screen.findByRole("button", { name: "Refresh role history" });
    expect(screen.getByRole("status")).toHaveTextContent("campaign binding could not be verified");
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
    expect(api.posts).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps a verified save confirmed if the subsequent screen refresh fails", async () => {
    server();
    review({ onSaved: () => Promise.reject(new Error("refresh failed")) });
    await openReview();
    addException();
    confirm();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The screen did not refresh"));
    expect(screen.getByRole("status")).toHaveTextContent("1 campaign saved, including 1 ad set");
    expect(screen.getByText("Saved exception")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
  });

  it("reconciles an ambiguous write using history without silently resubmitting", async () => {
    const api = server([], { failPost: 1 });
    review();
    await openReview();
    addException();
    confirm();
    await screen.findByRole("button", { name: "Refresh role history" });
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
    api.history.push(savedTestRole);
    fireEvent.click(screen.getByRole("button", { name: "Refresh role history" }));
    await screen.findByText("Saved exception");
    expect(api.posts).toHaveLength(1);
    expect(api.fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("Saved roles reloaded");
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
  });

  it("keeps the draft through Escape and restores focus to the toolbar button", async () => {
    const user = userEvent.setup();
    const api = server();
    review();
    const trigger = screen.getByRole("button", { name: /Main \/ Test roles/ });
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByText("Loading saved roles…")).toBeNull());
    chooseRole("Main");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("1 selected");
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeEnabled());
    expect(api.posts).toHaveLength(0);
  });

  it("scopes campaign suggestions to search and preserves manual choices", async () => {
    const api = server();
    review({ groups: [
      { ...groups[0]!, campaign: { ...node("campaign", "123", "main"), name: "MAIN East" }, adsets: groups[0]!.adsets },
      { ...groups[0]!, campaign: { ...node("campaign", "124", "test"), name: "TEST West" }, adsets: [] },
    ] });
    await openReview();
    chooseRole("Test", "MAIN East");
    fireEvent.change(screen.getByRole("textbox", { name: "Search campaigns" }), { target: { value: "West" } });
    fireEvent.click(screen.getByRole("button", { name: "Use 1 suggested role" }));
    expect(screen.getAllByRole("group", { name: /^Default role/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(within(screen.getByRole("group", { name: "Default role for MAIN East" })).getByRole("button", { name: "Test" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Selected 2" }));
    expect(screen.getAllByRole("group", { name: /^Default role/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("No campaigns selected yet")).toBeTruthy();
    expect(api.posts).toHaveLength(0);
  });

  it("removes matching defaults only after confirmation while retaining explicit exceptions", async () => {
    const api = server([savedTestRole]);
    const onSaved = vi.fn();
    review({ onSaved, groups: [{ ...groups[0]!, adsets: [
      groups[0]!.adsets[0]!, { ...node("adset", "457", "main", true), name: "Default cell" },
    ] }] });
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Remove confirmation" }));
    expect(screen.getByText("Removal selected")).toBeTruthy();
    expect(api.posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo campaign change" }));
    expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove confirmation" }));
    confirm();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.posts[0]!.declarations.map(({ entityId, event, role }) => [entityId, event, role])).toEqual([
      ["123", "revoke", null], ["457", "revoke", null],
    ]);
  });

  it.each([false, true])("batches large campaigns within the API limit and reconciles partial failures (failure=%s)", async (fail) => {
    const api = server([], { failPost: fail ? 2 : undefined });
    const onSaved = vi.fn();
    review({ onSaved, groups: [{
      ...groups[0]!,
      campaign: node("campaign", "123", "main"),
      adsets: Array.from({ length: 204 }, (_, i) => ({ ...node("adset", String(1000 + i), "main"), name: `Cell ${i}` })),
    }] });
    await openReview();
    chooseRole("Main");
    confirm();
    if (fail) {
      await screen.findByRole("button", { name: "Refresh role history" });
      expect(screen.getByRole("status")).toHaveTextContent("200 entity roles were verified");
      expect(screen.getByRole("button", { name: "Confirm campaign roles" })).toBeDisabled();
      expect(onSaved).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: /Main \/ Test roles/, hidden: true })).toHaveTextContent("0 to review");
    }
    expect(api.posts.map((post) => post.declarations.length)).toEqual([200, 5]);
  });
});
