import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DeferChip,
  buildTriageEventBody,
  nextDeferredIds,
  parseTriageState,
  postTriageEvent,
  reappearAt24h,
} from "@/components/common/briefing/DeferChip";

describe("DeferChip", () => {
  it("renders the exact defer copy and undo button", () => {
    const html = renderToStaticMarkup(<DeferChip id="card-1" />);

    expect(html).toContain("Reappears tomorrow 9am ·");
    expect(html).toContain("Undo");
    expect(html).toContain("data-action=\"undefer\"");
  });

  it("hides when not deferred", () => {
    expect(renderToStaticMarkup(<DeferChip id="card-1" deferred={false} />)).toBe("");
  });

  it("can render deferred state without an undo affordance", () => {
    const html = renderToStaticMarkup(<DeferChip id="card-1" showUndo={false} />);

    expect(html).toContain("Reappears tomorrow 9am");
    expect(html).not.toContain("Undo");
    expect(html).not.toContain("data-action=\"undefer\"");
  });

  it("hydrates deferred ids and count from triage state", () => {
    const parsed = parseTriageState(
      {
        rows: [
          { scopeType: "creative", scopeId: "a", action: "deferred" },
          { scopeType: "creative", scopeId: "b", action: "undeferred" },
          { scopeType: "campaign", scopeId: "c", action: "deferred" },
        ],
        deferredCount: 4,
      },
      "creative",
    );

    expect([...parsed.deferredIds]).toEqual(["a"]);
    expect(parsed.deferredCount).toBe(4);
  });

  it("builds optimistic defer and undefer sets", () => {
    const deferred = nextDeferredIds(new Set(["a"]), "b", "deferred");
    const undeferred = nextDeferredIds(deferred, "a", "undeferred");

    expect([...deferred]).toEqual(["a", "b"]);
    expect([...undeferred]).toEqual(["b"]);
  });

  it("posts defer and undefer events to the triage endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    const reappearAt = reappearAt24h(new Date("2026-05-07T00:00:00.000Z"));

    await postTriageEvent(
      {
        businessId: "biz_1",
        scopeType: "creative",
        scopeId: "cr_1",
        action: "deferred",
        reappearAt,
        snapshotDate: "2026-05-07",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/triage/event",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(
          buildTriageEventBody({
            businessId: "biz_1",
            scopeType: "creative",
            scopeId: "cr_1",
            action: "deferred",
            reappearAt,
            snapshotDate: "2026-05-07",
          }),
        ),
      }),
    );
  });

  it("surfaces failed writes so optimistic state can roll back", async () => {
    const previous = new Set(["a"]);
    const optimistic = nextDeferredIds(previous, "b", "deferred");
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: "triage failed" }),
    })) as unknown as typeof fetch;

    await expect(
      postTriageEvent(
        {
          businessId: "biz_1",
          scopeType: "creative",
          scopeId: "b",
          action: "deferred",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("triage failed");
    expect([...optimistic]).toEqual(["a", "b"]);
    expect([...previous]).toEqual(["a"]);
  });
});
