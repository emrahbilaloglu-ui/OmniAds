// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchOverlay, useSearchHotkey } from "@/components/zero-base/search/search-overlay";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { toZeroBaseSearchEnvelope } from "@/lib/zero-base/search-adapter";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(cleanup);

const envelope = toZeroBaseSearchEnvelope([
  { entityType: "business", entityId: "biz_1", name: "Grandmix", businessId: "biz_1" },
  { entityType: "ad", entityId: "a_9", name: "Summer hook", businessId: "biz_1" },
] as never);

function Harness(props: Partial<React.ComponentProps<typeof SearchOverlay>> = {}) {
  return (
    <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}>
      <ZeroBasePortalHost>
        <SearchOverlay
          open
          onOpenChange={vi.fn()}
          query="gr"
          onQueryChange={vi.fn()}
          envelope={envelope}
          {...props}
        />
      </ZeroBasePortalHost>
    </div>
  );
}

describe("SearchOverlay", () => {
  it("labels the scope exactly, so no unsupported provider is implied", async () => {
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("Businesses + Meta entities").length).toBeGreaterThan(0);
    expect(dialog.textContent).not.toMatch(/Google|Shopify|Klaviyo/);
  });

  it("links each result to its canonical route", async () => {
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/c/biz_1/home",
      "/c/biz_1/meta/decisions",
    ]);
  });

  it("moves a virtual cursor with arrows while focus stays in the input", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await screen.findByRole("combobox");
    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveFocus();
    expect(input.getAttribute("aria-activedescendant")).toContain("-1");
  });

  it("distinguishes no-permission from no-match", async () => {
    const { rerender } = render(<Harness envelope={toZeroBaseSearchEnvelope([])} />);
    expect(await screen.findByText(/businesses and Meta entities only/)).toBeVisible();

    rerender(<Harness envelope={toZeroBaseSearchEnvelope([])} permissionEmpty />);
    expect(await screen.findByText(/do not have access to any business/)).toBeVisible();
  });

  it("renders the truncation disclosure when results were capped", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      entityType: "ad" as const,
      entityId: `a_${i}`,
      name: `Ad ${i}`,
      businessId: "biz_1",
    }));
    render(<Harness envelope={toZeroBaseSearchEnvelope(many as never)} />);
    expect(await screen.findByText(/top 50 of 120/)).toBeVisible();
  });
});

describe("useSearchHotkey", () => {
  it("opens on / from the page", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderHook(() => useSearchHotkey(onOpen));
    await user.keyboard("/");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not hijack / while the user is typing in a field", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderHook(() => useSearchHotkey(onOpen));
    render(<input aria-label="Notes" />);
    await user.click(screen.getByLabelText("Notes"));
    await user.keyboard("/");
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Notes")).toHaveValue("/");
  });
});
