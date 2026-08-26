// @vitest-environment jsdom

/**
 * WP9 · Recommendations → respond, end to end on the mounted client.
 *
 * The control existed and led nowhere: the server counted the recommendations
 * and threw the ids away, so the handler could only tell the operator to open
 * Decision Center. A control that names an action and then declines to take it
 * is worse than no control — it reads as a capability.
 *
 * These cases are about the request that leaves the browser. The gate itself is
 * the server's and is proven in `lib/zero-base/meta/intelligence-server.test.ts`;
 * what is proven here is that an enabled control posts a SERVED id, a refused
 * one posts nothing, and a refusal the server wrote is the refusal the operator
 * reads.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IntelligenceControlsClient } from "@/components/zero-base/meta/intelligence/intelligence-controls-client";
import type { IntelligenceSource } from "@/components/zero-base/meta/intelligence/intelligence-view";

const BUSINESS = "biz_1";

function respondSource(
  control: Partial<NonNullable<IntelligenceSource["control"]>> = {},
): IntelligenceSource {
  return {
    key: "recommendations",
    label: "Recommendations",
    state: "serving",
    reason: null,
    observedAt: "2026-08-11T05:00:00.000Z",
    facts: [{ label: "Recommendations", value: "2" }],
    control: {
      kind: "respond",
      enabled: true,
      refusalCode: null,
      refusalMessage: null,
      targets: [
        { recId: "rec_a", label: "Scale the winning ad set" },
        { recId: "rec_b", label: "Hold spend" },
      ],
      ...control,
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      response: {
        recId: "rec_a",
        businessId: BUSINESS,
        action: "acted",
        timestamp: "2026-08-11T09:30:00.000Z",
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the respond control acts on a served recommendation", () => {
  it("posts the server's own recId, never one composed here", async () => {
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "acted",
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/meta/recommendations/respond");
    expect(init.method).toBe("POST");
    // The first served target, because none was chosen. The id is the
    // snapshot's; nothing here can invent one.
    expect(JSON.parse(String(init.body))).toEqual({
      recId: "rec_a",
      businessId: BUSINESS,
      // The physical account travels with the response: the write boundary
      // checks the rec against THIS account's current snapshot, and a response
      // sent without one is refused.
      providerAccountId: null,
      action: "acted",
    });
  });

  it("records against the recommendation the operator chose", async () => {
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Which recommendation — Recommendations"),
      "rec_b",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "deferred",
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)),
    ).toMatchObject({ recId: "rec_b", action: "deferred" });
  });

  it("reads the outcome back from the server's row, not from the click", async () => {
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "acted",
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("rec_a");
    expect(notice.textContent).toContain("2026-08-11T09:30:00.000Z");
    // And it never says "open Decision Center" — the action happens here.
    expect(notice.textContent).not.toContain("Decision Center");
  });

  it("restates the server's refusal rather than composing one", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        ok: false,
        error: {
          code: "reviewer_read_only",
          message: "Reviewer access is read-only.",
        },
      }),
    } as never);
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "ignored",
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe("Reviewer access is read-only.");
  });

  it("reads the access layer's other envelope too", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: "auth_error",
        message: "You do not have access to this business.",
      }),
    } as never);
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "acted",
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "You do not have access to this business.",
    );
  });

  it("says the server gave no readable reason rather than inventing one", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => null,
    } as never);
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "acted",
    );

    expect((await screen.findByRole("status")).textContent).toContain(
      "no reason that could be read",
    );
  });
});

describe("a refused control posts nothing", () => {
  for (const [label, refusalCode, refusalMessage] of [
    ["a reviewer", "reviewer_read_only", "Reviewer access is read-only."],
    [
      "a demo workspace",
      "demo_business_read_only",
      "Demo workspaces have zero Meta write authority.",
    ],
    [
      "a guest",
      "insufficient_role",
      "This action needs at least collaborator access.",
    ],
  ] as const) {
    it(`refuses ${label} before the click, and issues no request`, async () => {
      render(
        <IntelligenceControlsClient
          businessId={BUSINESS}
          sources={[
            respondSource({ enabled: false, refusalCode, refusalMessage }),
          ]}
        />,
      );

      const select = screen.getByLabelText(
        "Record a response — Recommendations",
      ) as HTMLSelectElement;
      expect(select.disabled).toBe(true);
      expect(screen.getByText(refusalMessage)).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("refuses when the snapshot served nothing to respond to", async () => {
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        sources={[
          respondSource({
            enabled: false,
            refusalCode: null,
            refusalMessage:
              "This snapshot served no recommendations, so there is nothing to respond to.",
            targets: [],
          }),
        ]}
      />,
    );

    // No subject select at all, because there is no subject.
    expect(
      screen.queryByLabelText("Which recommendation — Recommendations"),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Record a response — Recommendations") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        "This snapshot served no recommendations, so there is nothing to respond to.",
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends the account this surface is scoped to", async () => {
    render(
      <IntelligenceControlsClient
        businessId={BUSINESS}
        providerAccountId="act_1"
        sources={[respondSource()]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Record a response — Recommendations"),
      "acted",
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)),
    ).toMatchObject({ providerAccountId: "act_1" });
  });

});
