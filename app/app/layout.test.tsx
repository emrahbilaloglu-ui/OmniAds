import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionFromCookies } = vi.hoisted(() => ({ getSessionFromCookies: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getSessionFromCookies }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
}));

import WorkspaceLayout from "./layout";

describe("session-scoped app layout", () => {
  beforeEach(() => {
    getSessionFromCookies.mockResolvedValue({
      activeBusinessId: "business-1",
      user: { id: "user-1" },
    });
  });

  it("passes through the routed client page without mounting a second shell", async () => {
    const child = <div data-testid="canonical-client-page">Page</div>;

    await expect(WorkspaceLayout({ children: child })).resolves.toBe(child);
  });

  it("keeps the public app boundary authenticated", async () => {
    getSessionFromCookies.mockResolvedValue(null);

    await expect(WorkspaceLayout({ children: <div /> })).rejects.toThrow(
      "redirect:/login?next=%2Fapp%2Fhome",
    );
  });
});
