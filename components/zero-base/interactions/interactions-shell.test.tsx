// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — contracts owned by the shell, the scope sheet, the
 * agency desk and creative media.
 *
 * Every case here drives the control on the component that actually owns it.
 * That distinction is the whole point of G7 and it is easy to lose: an earlier
 * pass "proved" live:media-play by rendering a still image and asserting its
 * alt text, live:media-retry by rendering a *missing* asset that has no retry,
 * live:cancel with a bare `<Button>Cancel</Button>`, and MOBILE-02 by rendering
 * the scope sheet already open rather than operating the control that opens it.
 * Each of those passes while the real control is broken or absent.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { AppShell } from "@/components/zero-base/shell/app-shell";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import { CreativeCarousel, CreativeMedia } from "@/components/zero-base/creative/creative-media";
import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/a/desk",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

const SCOPE: ScopeFacts = {
  scopeContext: "Client",
  enteredFrom: "Agency Desk",
  businessName: "Halcyon Supply Co.",
  providerLabel: "Meta",
  providerAccountLabel: "act_298410771 · Halcyon Main",
  evidenceWindowLabel: "Jul 13 – Aug 9",
  configuredCurrency: "USD",
  currencyProof: "proven",
  businessTimezone: "America/New_York",
  timezoneProof: "aligned",
  freshness: "fresh",
  snapshotAt: "2026-08-09T06:00:00Z",
};

/** matchMedia is not implemented in jsdom; the shell asks it for the viewport. */
function setViewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: () => ({
      matches: narrow,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderShell(
  options: {
    narrow?: boolean;
    pickers?: Record<string, () => void>;
    agencyReturn?: { href: string; label: string } | null;
  } = {},
) {
  setViewport(options.narrow ?? false);
  return render(
    <ZeroBaseCopyProvider language="en">
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz"
        pathname="/c/biz/home"
        title="Halcyon Supply Co."
        scope={SCOPE}
        initialNarrow={options.narrow ?? false}
        railFooter={<p>Dana Whitfield</p>}
        agencyReturn={options.agencyReturn}
        scopePickers={options.pickers}
      >
        <p>Surface content</p>
      </AppShell>
    </ZeroBaseCopyProvider>,
  );
}

const AGENCY_PAGE = {
  items: [
    {
      businessId: "biz-0",
      name: "Halcyon Supply Co.",
      role: "Agency collaborator",
      configuredCurrency: "USD",
      sourceUpdatedAt: "2026-08-09",
      membershipStatus: "active" as const,
      href: "/c/biz-0/home",
    },
    {
      businessId: "biz-1",
      name: "Northwind Trading",
      role: "Agency collaborator",
      configuredCurrency: "USD",
      sourceUpdatedAt: null,
      membershipStatus: "active" as const,
      href: "/c/biz-1/home",
    },
  ],
  servedCount: 2,
  totalCount: 14,
  nextCursor: "cursor-2",
  truncated: true,
  disclosure: null,
};

function renderAgency() {
  return render(
    <ZeroBaseCopyProvider language="en">
      <AgencyDeskView initialPage={AGENCY_PAGE} />
    </ZeroBaseCopyProvider>,
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
});
afterAll(() => flushInteractionResults("shell"));

/* ------------------------------------------------------------------ shell */

describe("G7 — shell navigation", () => {
  interactionCase("live:nav", async () => {
    renderShell();
    const rail = document.querySelector("[data-rail]");
    expect(rail, "the wide shell renders a rail").not.toBeNull();

    const items = rail!.querySelectorAll<HTMLElement>('[data-ctl="live:nav"]');
    expect(items.length, "the rail carries nav items").toBeGreaterThan(1);

    // Routes to a real surface, and the current item is marked as such.
    const first = expectOperable(items[0], "rail nav item");
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toMatch(/^\/app\//);

    const current = rail!.querySelector('[aria-current="page"]');
    expect(current, "the active surface is marked, not merely tinted").not.toBeNull();
    expect(current!.getAttribute("href")).toBe("/app/home");

    // Nav is a landmark, and the skip link precedes it.
    expect(rail!.tagName).toBe("NAV");
    const skip = screen.getByRole("link", { name: /skip/i });
    expect(
      skip.compareDocumentPosition(rail!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "skip link precedes the nav",
    ).toBeTruthy();
  });

  interactionCase("live:nav-drawer", async () => {
    const user = userEvent.setup();
    renderShell({ narrow: true });

    // At narrow widths the rail is replaced by the drawer trigger.
    expect(document.querySelector("[data-rail]")).toBeNull();
    const trigger = expectOperable(
      document.querySelector('[data-ctl="live:nav-drawer"]'),
      "drawer trigger",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-nav-drawer]")).toBeNull();

    await user.click(trigger);

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("navigation")).toBeTruthy();
    // The complete rail, not a reduced one: a drawer that omits modules
    // teaches the user those modules do not exist on their phone.
    // Module buttons add a fast parent-level entry, while every leaf remains
    // present as a real link. Count the leaves rather than treating the parent
    // entries as duplicate or missing navigation.
    const drawerItems = drawer.querySelectorAll('a[data-ctl="live:nav"]');
    expect(drawerItems.length).toBe(navGroupsFor("Client").flatMap((g) => g.items).length);
  });

  interactionCase("live:nav-drawer close", async () => {
    const user = userEvent.setup();
    renderShell({ narrow: true });
    await user.click(document.querySelector('[data-ctl="live:nav-drawer"]')!);
    const drawer = await screen.findByRole("dialog");

    const close = expectOperable(
      drawer.querySelector('[data-ctl="live:nav-drawer close"]'),
      "drawer close",
    );
    await user.click(close);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Focus returns to the hamburger, not to the top of the document.
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-ctl="live:nav-drawer"]')),
    );
  });

  interactionCase("live:MOBILE-02 scope-sheet", async () => {
    const user = userEvent.setup();
    renderShell({ narrow: true });

    // The compact context bar is the control; the sheet is its consequence.
    const bar = expectOperable(
      document.querySelector('[data-ctl="live:MOBILE-02 scope-sheet"]'),
      "compact context bar",
    );
    // Its whole accessible name is the scope, so it is useful before opening.
    expect(bar.getAttribute("aria-label")).toContain("Business: Halcyon Supply Co.");
    expect(document.querySelector('[data-el="scope-sheet-open"]')).toBeNull();

    await user.click(bar);

    await waitFor(() =>
      expect(document.querySelector('[data-el="scope-sheet-open"]')).not.toBeNull(),
    );
    // All eight facts, unconditionally.
    expect(document.querySelectorAll("[data-scope-fact]")).toHaveLength(8);
  });
});

/* ------------------------------------------------------------ scope sheet */

describe("G7 — scope sheet pickers", () => {
  const openSheet = async (pickers: Record<string, () => void>) => {
    const user = userEvent.setup();
    renderShell({ narrow: true, pickers });
    await user.click(document.querySelector('[data-ctl="live:MOBILE-02 scope-sheet"]')!);
    await screen.findByRole("dialog");
    return user;
  };

  interactionCase("live:AUTH-10 scope-switch", async () => {
    const onSwitchScope = vi.fn();
    const user = await openSheet({ onSwitchScope });
    const control = expectOperable(
      document.querySelector('[data-ctl="live:AUTH-10 scope-switch"]'),
      "scope switch",
    );
    // The picker names the fact it changes, so it is not a bare glyph.
    expect(control.getAttribute("aria-label")).toContain("Client");
    await user.click(control);
    expect(onSwitchScope).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:AUTH-10 business-switcher", async () => {
    const onSwitchBusiness = vi.fn();
    const user = await openSheet({ onSwitchBusiness });
    const control = expectOperable(
      document.querySelector('[data-ctl="live:AUTH-10 business-switcher"]'),
      "business switcher",
    );
    expect(control.getAttribute("aria-label")).toContain("Halcyon Supply Co.");
    await user.click(control);
    expect(onSwitchBusiness).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:SCOPE-03 account-picker", async () => {
    const onPickAccount = vi.fn();
    const user = await openSheet({ onPickAccount });
    const control = expectOperable(
      document.querySelector('[data-ctl="live:SCOPE-03 account-picker"]'),
      "account picker",
    );
    expect(control.getAttribute("aria-label")).toContain("act_298410771");
    await user.click(control);
    expect(onPickAccount).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:SCOPE-10 window-picker", async () => {
    const onPickWindow = vi.fn();
    const user = await openSheet({ onPickWindow });
    const control = expectOperable(
      document.querySelector('[data-ctl="live:SCOPE-10 window-picker"]'),
      "window picker",
    );
    expect(control.getAttribute("aria-label")).toContain("Jul 13 – Aug 9");
    await user.click(control);
    expect(onPickWindow).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:cancel", async () => {
    const user = await openSheet({ onPickWindow: vi.fn() });
    const cancel = expectOperable(
      document.querySelector('[data-ctl="live:cancel"]'),
      "scope sheet cancel",
    );
    await user.click(cancel);
    // Closes, and nothing was mutated on the way out.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('[data-ctl="live:MOBILE-02 scope-sheet"]'),
      ),
    );
  });

  it("a row whose picker the actor cannot service renders no picker at all", async () => {
    const user = userEvent.setup();
    renderShell({ narrow: true, pickers: {} });
    await user.click(document.querySelector('[data-ctl="live:MOBILE-02 scope-sheet"]')!);
    await screen.findByRole("dialog");
    // AUTH-10 is explicit: no agency membership means the segment is absent,
    // never a disabled teaser that claims a capability the actor lacks.
    expect(document.querySelector('[data-ctl="live:AUTH-10 scope-switch"]')).toBeNull();
    // The fact itself is still stated — only the control is gone.
    expect(document.querySelector('[data-el="scope-f-context"]')).not.toBeNull();
  });
});

/* ----------------------------------------------------------- agency desk */

describe("G7 — agency desk", () => {
  interactionCase("live:AGENCY-04 open-client", async () => {
    renderAgency();
    const link = expectOperable(
      document.querySelector('[data-ctl="live:AGENCY-04 open-client"]'),
      "open client",
    );
    // The return carries the row's own page, so returning lands where they left.
    const href = expectNavigates(link, /^\/switch-business\/biz-0\?/, "open client");
    expect(decodeURIComponent(href)).toContain("next=/app/home");
    expect(decodeURIComponent(href)).toContain("row=biz-0");
  });

  interactionCase("live:AGENCY-02 withheld-explainer", async () => {
    renderAgency();
    const link = expectOperable(
      document.querySelector('[data-ctl="live:AGENCY-02 withheld-explainer"]'),
      "withheld explainer",
    );
    // The desk states that totals are withheld and links to why — it does not
    // simply omit them.
    expect(document.querySelector('[data-el="withheld-tile"]')?.textContent).toContain("withheld");
    expectNavigates(link, /^\/a\/desk\/withheld$/, "withheld explainer");
  });

  interactionCase("live:SCOPE-11 client-search", async () => {
    const user = userEvent.setup();
    renderAgency();
    const search = expectOperable(
      document.querySelector('[data-ctl="live:SCOPE-11 client-search"]'),
      "client search",
    );
    expect(screen.getByText("Northwind Trading")).toBeTruthy();

    await user.type(search, "Northwind");

    // Filters the loaded rows, and says so rather than looking like the whole
    // directory shrank.
    await waitFor(() => expect(screen.queryByText("Halcyon Supply Co.")).toBeNull());
    expect(screen.getByText("Northwind Trading")).toBeTruthy();
  });

  interactionCase("live:AGENCY-04 load-more", async () => {
    renderAgency();
    const more = expectOperable(
      document.querySelector('[data-ctl="live:AGENCY-04 load-more"]'),
      "load more",
    );
    // Disclosure states what is shown against what exists, so paging is a
    // decision rather than a guess.
    expect(document.body.textContent).toContain("Showing 2 of 14 clients.");
    expect(more.getAttribute("aria-disabled")).not.toBe("true");
  });
});

/* ----------------------------------------------------------------- media */

describe("G7 — creative media", () => {
  interactionCase("live:media-play", async () => {
    const user = userEvent.setup();
    render(
      <ZeroBaseCopyProvider language="en">
        <CreativeMedia
          state={{
            kind: "video",
            url: "https://example.test/a.mp4",
            poster: "https://example.test/a.jpg",
            captionsUrl: "https://example.test/a.vtt",
            origin: "snapshot",
          }}
          label="Summer hero"
        />
      </ZeroBaseCopyProvider>,
    );

    const play = expectOperable(document.querySelector('[data-ctl="live:media-play"]'), "play");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    // Captions are contract, not enhancement.
    expect(document.querySelector('track[kind="captions"]')).not.toBeNull();

    await user.click(play);

    // Pause toggles, and the state is announced rather than only drawn.
    await waitFor(() => expect(play.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("status").textContent).toBe("Playing");
    await user.click(play);
    await waitFor(() => expect(play.getAttribute("aria-pressed")).toBe("false"));
  });

  interactionCase("live:media-retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ZeroBaseCopyProvider language="en">
        <CreativeMedia
          state={{ kind: "failed", reason: "Stream returned 502.", alt: "Summer hero" }}
          label="Summer hero"
          onRetry={onRetry}
        />
      </ZeroBaseCopyProvider>,
    );

    // Verbatim, so a transient stream failure is distinguishable from a
    // revoked asset.
    expect(screen.getByText("Stream returned 502.")).toBeTruthy();
    // Alt text survives the failure.
    expect(screen.getByRole("img", { name: "Summer hero" })).toBeTruthy();

    const retry = expectOperable(document.querySelector('[data-ctl="live:media-retry"]'), "retry");
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:CREATIVE-02 carousel-dot", async () => {
    const user = userEvent.setup();
    render(
      <ZeroBaseCopyProvider language="en">
        <CreativeCarousel
          label="Summer carousel"
          cards={[
            { id: "a", media: { kind: "ready", url: "https://x/1.png", origin: "snapshot" } },
            { id: "b", media: { kind: "ready", url: "https://x/2.png", origin: "snapshot" } },
            { id: "c", media: { kind: "missing", reason: "No preview captured." } },
          ]}
        />
      </ZeroBaseCopyProvider>,
    );

    // Position is text, not a tinted dot: a colour alone announces nothing.
    expect(screen.getByRole("status").textContent).toBe("Card 1 of 3");
    const dots = document.querySelectorAll<HTMLElement>('[data-ctl="live:CREATIVE-02 carousel-dot"]');
    expect(dots).toHaveLength(3);
    expect(dots[0].getAttribute("aria-current")).toBe("true");

    await user.click(dots[2]);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Card 3 of 3"));
    expect(dots[2].getAttribute("aria-current")).toBe("true");
    expect(dots[0].getAttribute("aria-current")).toBeNull();
  });
});

/* --------------------------------------------- mutation / negative controls */

describe("G7 mutation controls — these fail if a real control regresses", () => {
  it("the drawer trigger only exists at narrow widths, and the rail only at wide", () => {
    renderShell({ narrow: false });
    expect(document.querySelector('[data-ctl="live:nav-drawer"]')).toBeNull();
    expect(document.querySelector("[data-rail]")).not.toBeNull();
    cleanup();

    renderShell({ narrow: true });
    expect(document.querySelector('[data-ctl="live:nav-drawer"]')).not.toBeNull();
    expect(document.querySelector("[data-rail]")).toBeNull();
  });

  it("agency return appears only when a return actually exists", () => {
    renderShell({ agencyReturn: null });
    expect(document.querySelector('[data-el="agency-return"]')).toBeNull();
    cleanup();

    renderShell({ agencyReturn: { href: "/a/desk?row=biz-0", label: "← Agency Desk" } });
    const back = document.querySelector('[data-el="agency-return"]');
    expect(back).not.toBeNull();
    // The desk's context travels with it.
    expect(back!.getAttribute("href")).toContain("row=biz-0");
  });

  it("a missing asset offers no retry, because retrying cannot succeed", () => {
    render(
      <ZeroBaseCopyProvider language="en">
        <CreativeMedia
          state={{ kind: "missing", reason: "No preview was captured." }}
          label="Summer hero"
          onRetry={() => {}}
        />
      </ZeroBaseCopyProvider>,
    );
    expect(document.querySelector('[data-ctl="live:media-retry"]')).toBeNull();
    expect(screen.getByText(/No preview/)).toBeTruthy();
  });

  it("the scope sheet states every fact even when values are unknown", async () => {
    const user = userEvent.setup();
    setViewport(true);
    render(
      <ZeroBaseCopyProvider language="en">
        <AppShell
          groups={navGroupsFor("Client")}
          businessId="biz"
          pathname="/c/biz/home"
          title="Unknown"
          initialNarrow
          scope={{
            ...SCOPE,
            businessName: null,
            providerLabel: null,
            providerAccountLabel: null,
            businessTimezone: null,
            timezoneProof: "missing",
          }}
          railFooter={null}
        >
          <p>Surface</p>
        </AppShell>
      </ZeroBaseCopyProvider>,
    );
    await user.click(document.querySelector('[data-ctl="live:MOBILE-02 scope-sheet"]')!);
    const sheet = await screen.findByRole("dialog");
    // Eight either way — a dropped row reads as "this fact agrees".
    expect(document.querySelectorAll("[data-scope-fact]")).toHaveLength(8);
    expect(within(sheet).getByText(/TZ Unknown · not set/)).toBeTruthy();
  });
});
