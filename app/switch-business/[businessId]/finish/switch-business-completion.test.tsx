// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { CompleteBusinessSwitch } from "./switch-business-completion";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("posts the authorized business switch before a full document navigation", async () => {
  const post = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ activeBusinessId: "business_B" }),
  });
  const replace = vi.fn();
  vi.stubGlobal("fetch", post);
  vi.stubGlobal("location", { replace });

  render(
    <CompleteBusinessSwitch
      businessId="business_B"
      destination="/c/business_B/meta/decisions?scope=creatives"
      alreadyActive={false}
    />,
  );

  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(post).toHaveBeenCalledWith(
    "/api/auth/switch-business",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ businessId: "business_B" }),
    }),
  );
  expect(post.mock.invocationCallOrder[0]).toBeLessThan(
    replace.mock.invocationCallOrder[0]!,
  );
  expect(replace).toHaveBeenCalledWith(
    "/c/business_B/meta/decisions?scope=creatives",
  );
});

it("keeps the old workspace when the switch is refused and retries on request", async () => {
  const post = vi.fn()
    .mockResolvedValueOnce({ ok: false, json: async () => null })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ activeBusinessId: "business_B" }),
    });
  const replace = vi.fn();
  vi.stubGlobal("fetch", post);
  vi.stubGlobal("location", { replace });

  render(
    <CompleteBusinessSwitch
      businessId="business_B"
      destination="/c/business_B/meta/decisions"
      alreadyActive={false}
    />,
  );

  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(post).toHaveBeenCalledTimes(2);
});
