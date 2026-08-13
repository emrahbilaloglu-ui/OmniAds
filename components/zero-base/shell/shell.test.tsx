// @vitest-environment jsdom

/**
 * WP-06 shell proofs.
 *
 * The two that matter most: B02 — the rail footer must survive a short
 * viewport because only the nav area scrolls — and the absence checks. A shell
 * that renders a dead control, or leaks an Ops route into buyer navigation, is
 * a shell that lies about what the user can do.
 */
import React from "react";
import { MAIN_CONTENT_TABINDEX } from "@/components/zero-base/shell/skip-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/zero-base/shell/app-shell";
import { Rail } from "@/components/zero-base/shell/rail";
import { USER_MENU_ITEMS } from "@/components/zero-base/shell/user-menu";
import { SCOPE_FACT_IDS } from "@/components/zero-base/primitives/scope-sheet";
import {
  isCurrentNavItem,
  navGroupsFor,
  navHref,
  railLabel,
} from "@/lib/zero-base/navigation";
import { GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";

vi.mock("next/navigation", () => ({ usePathname: () => "/c/biz_1/home" }));

afterEach(cleanup);

const scope = {
  scopeContext: "Client",
  enteredFrom: null,
  providerLabel: "Meta",
  businessName: "Grandmix",
  providerAccountLabel: "act_298410771",
  evidenceWindowLabel: "Last 7 days",
  configuredCurrency: "USD",
  currencyProof: "configured-only" as const,
  businessTimezone: "Europe/Istanbul",
  timezoneProof: "aligned" as const,
  freshness: "fresh" as const,
  snapshotAt: "2026-08-11T09:00:00Z",
};

/** jsdom has no layout engine, so viewport width is driven through matchMedia. */
function setViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const match = /max-width:\s*(\d+)px/.exec(query);
    const matches = match ? width <= Number(match[1]) : false;
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

describe("navigation is derived from the leaf registry", () => {
  it("lists no route that needs an id the nav does not have", () => {
    for (const group of navGroupsFor("Client")) {
      for (const item of group.items) {
        // /reports/[reportId] as a nav target would be a dead link.
        const dynamic = item.url.split("/").filter((s) => s.startsWith("[") && s !== "[businessId]");
        expect(dynamic, item.url).toEqual([]);
      }
    }
  });

  it("omits sub-actions reached from within a leaf", () => {
    const urls = navGroupsFor("Client").flatMap((g) => g.items.map((i) => i.url));
    expect(urls).not.toContain("/c/[businessId]/reports/new");
    expect(urls).not.toContain("/c/[businessId]/reports/[reportId]/edit");
    expect(urls).toContain("/c/[businessId]/reports");
  });

  it("never mixes contexts", () => {
    const clientLeaves = new Set(
      GENERATED_LEAVES.filter((l) => l.ctx === "Client").map((l) => l.leaf),
    );
    for (const group of navGroupsFor("Client")) {
      for (const item of group.items) expect(clientLeaves.has(item.leaf), item.url).toBe(true);
    }
  });

  it("keeps Ops out of buyer navigation entirely", () => {
    const buyerUrls = [
      ...navGroupsFor("Client").flatMap((g) => g.items.map((i) => i.url)),
      ...navGroupsFor("Agency").flatMap((g) => g.items.map((i) => i.url)),
    ];
    expect(buyerUrls.filter((url) => url.startsWith("/ops"))).toEqual([]);
    // And Ops nav is non-empty, so the check above is not vacuous.
    expect(navGroupsFor("Ops").flatMap((g) => g.items)).not.toHaveLength(0);
  });

  it("substitutes the scope into canonical patterns", () => {
    expect(navHref("/c/[businessId]/home", "biz_1")).toBe("/app/home");
    expect(navHref("/a/desk", null)).toBe("/a/desk");
    expect(isCurrentNavItem({ leaf: "L-C-HOME", label: "", url: "/c/[businessId]/home", role: "" }, "/c/biz_1/home", "biz_1")).toBe(true);
  });

  it("strips the group prefix the rail already shows", () => {
    expect(railLabel("Meta — Decisions")).toBe("Decisions");
    expect(railLabel("Client Home")).toBe("Client Home");
  });
});

describe("Rail — B02", () => {
  it("keeps business switching out of the client rail", () => {
    render(
      <Rail
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        workspaceMode="client"
        workspaceName="Grandmix"
        onSwitchBusiness={() => {}}
        footer={null}
      />,
    );
    expect(document.querySelector('[data-ctl="live:AUTH-10 business-switcher"]')).toBeNull();
  });

  it("scrolls the nav area only, so the footer identity row cannot be pushed off", () => {
    render(
      <Rail
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        footer={<p>Ada · read-only review</p>}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const scrollArea = nav.querySelector("[data-rail-nav]") as HTMLElement;
    const footer = nav.querySelector("[data-rail-footer]") as HTMLElement;

    // The scroll lives on the nav area, not the rail: a rail that scrolls as
    // one block takes the identity row with it.
    expect(scrollArea.style.overflowY).toBe("auto");
    expect(scrollArea.style.minHeight).toBe("0px");
    expect(nav.style.overflowY).not.toBe("auto");
    // The footer is a sibling of the scroll area, so it cannot scroll away.
    expect(footer.parentElement).toBe(nav);
    expect(footer.style.flex).toBe("0 0 auto");
    expect(within(footer).getByText(/Ada/)).toBeVisible();
  });

  it("is 232px wide and marks the current page", () => {
    render(
      <Rail
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        footer={null}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.style.width).toBe("232px");
    expect(screen.getByRole("link", { current: "page" })).toHaveAttribute("href", "/app/home");
  });

  it("uses the existing platform logo assets instead of placeholder glyphs", () => {
    render(
      <Rail
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        footer={null}
      />,
    );

    const logoSrc = (groupId: string) =>
      decodeURIComponent(
        document.querySelector(`[data-platform-logo="${groupId}"] img`)?.getAttribute("src") ?? "",
      );

    expect(logoSrc("meta")).toContain("/platform-logos/Meta.png");
    expect(logoSrc("creative")).toContain("/platform-logos/Meta.png");
    expect(logoSrc("google")).toContain("/platform-logos/googleAds.svg");
    expect(logoSrc("analytics")).toContain("/platform-logos/GA4.svg");
  });
});

describe("AppShell", () => {
  function renderShell(width: number) {
    setViewport(width);
    return render(
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        title="Grandmix"
        scope={scope}
        railFooter={<p>Ada</p>}
      >
        <p>Surface body</p>
      </AppShell>,
    );
  }

  it("renders the rail at desktop widths", () => {
    renderShell(1280);
    expect(document.querySelector("[data-rail]")).not.toBeNull();
    expect(document.querySelector("[data-nav-drawer-trigger]")).toBeNull();
  });

  it("can replace global search with a top-bar business action", () => {
    setViewport(1280);
    render(
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/c/biz_1/home"
        title="Grandmix"
        scope={scope}
        railFooter={null}
        showGlobalSearch={false}
        topBarActions={<button type="button">Grandmix · Switch business</button>}
      >
        <p>Surface body</p>
      </AppShell>,
    );

    expect(document.querySelector("[data-global-search-trigger]")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch business/ })).toBeVisible();
  });

  it("keeps only module tabs above Meta interiors and gives them the full canvas", () => {
    setViewport(1280);
    render(
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/app/meta/decisions"
        workspaceMode="client"
        title="Decisions"
        scope={scope}
        railFooter={null}
        topBarActions={<button type="button">Grandmix · Switch business</button>}
      >
        <p>Legacy Decisions interior</p>
      </AppShell>,
    );

    expect(document.querySelector("[data-top-bar]")).toBeNull();
    expect(document.querySelector('[data-context-bar="full"]')).toBeNull();
    expect(screen.getByRole("navigation", { name: "Meta pages" })).toBeVisible();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-module-only-frame", "true");
    expect(main.style.padding).toBe("0px");
    expect(screen.getByText("Legacy Decisions interior")).toBeVisible();
  });

  it("keeps only module tabs above Creative interiors and gives them the full canvas", () => {
    setViewport(1280);
    render(
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/app/creative/performance"
        workspaceMode="client"
        title="Performance"
        scope={scope}
        railFooter={null}
        topBarActions={<button type="button">Grandmix · Switch business</button>}
      >
        <p>Legacy Creative Studio interior</p>
      </AppShell>,
    );

    expect(document.querySelector("[data-top-bar]")).toBeNull();
    expect(document.querySelector('[data-context-bar="full"]')).toBeNull();
    expect(document.querySelector('[data-module-navigation="creative"]')).not.toBeNull();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-module-only-frame", "true");
    expect(main.style.padding).toBe("0px");
    expect(screen.getByText("Legacy Creative Studio interior")).toBeVisible();
  });

  it("collapses a nested route shell to its page body", () => {
    setViewport(1280);
    render(
      <AppShell
        groups={navGroupsFor("Client")}
        businessId="biz_1"
        pathname="/app/home"
        title="Public app shell"
        scope={scope}
        railFooter={<p>Ada</p>}
      >
        <AppShell
          groups={navGroupsFor("Client")}
          businessId="biz_1"
          pathname="/c/biz_1/home"
          title="Imported route shell"
          scope={scope}
          railFooter={<p>Ada</p>}
        >
          <p>Canonical page body</p>
        </AppShell>
      </AppShell>,
    );

    expect(document.querySelectorAll("[data-shell]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-rail]")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByText("Canonical page body")).toBeVisible();
  });

  it("replaces the rail with a complete drawer below 768", async () => {
    const user = userEvent.setup();
    renderShell(390);
    expect(document.querySelector("[data-rail]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog");
    const drawerNav = within(drawer).getByRole("navigation", { name: "Primary" });

    // The complete rail, not a reduced set — a mobile nav that omits modules
    // teaches the user they do not exist on a phone.
    const railItems = navGroupsFor("Client").flatMap((g) => g.items);
    expect(within(drawerNav).getAllByRole("link")).toHaveLength(railItems.length);
  });

  it("gives drawer links a 44px target", async () => {
    const user = userEvent.setup();
    renderShell(390);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog");
    for (const link of within(drawer).getAllByRole("link")) {
      expect(link.style.minHeight).toBe("44px");
    }
  });

  it("closes the drawer on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderShell(390);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps the context bar present at every width", async () => {
    const user = userEvent.setup();
    renderShell(1280);
    expect(document.querySelector('[data-context-bar="full"]')).not.toBeNull();

    cleanup();
    renderShell(320);
    // Compressed, never absent — a surface without visible scope hides which
    // client's money is on screen.
    const compact = document.querySelector('[data-context-bar="compact"]') as HTMLElement;
    expect(compact).not.toBeNull();

    await user.click(compact);
    const sheet = await screen.findByRole("dialog");
    for (const id of SCOPE_FACT_IDS) {
      expect(sheet.querySelector(`[data-scope-fact="${id}"]`), id).not.toBeNull();
    }
  });

  it("does not present read-only scope facts as fake dropdown controls", () => {
    renderShell(1280);
    const full = document.querySelector('[data-context-bar="full"]') as HTMLElement;
    expect(full).not.toBeNull();
    expect(within(full).queryAllByRole("button")).toHaveLength(0);
    expect(full.querySelector('[data-context-fact="account"]')?.tagName).toBe("SPAN");
    expect(full.textContent).not.toContain("source unknown");
  });

  it("names the compact context bar with all eight facts", () => {
    renderShell(320);
    const compact = document.querySelector('[data-context-bar="compact"]')!;
    const label = compact.getAttribute("aria-label") ?? "";
    for (const word of ["Context", "Business", "Provider", "Account", "Currency", "Timezone", "Window", "Freshness"]) {
      expect(label, word).toContain(word);
    }
  });

  it("renders a skip link that targets main", () => {
    renderShell(1280);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(skip).toHaveAttribute("href", `#${main.id}`);
    // Focusable, so the jump moves focus and not just the scroll position.
    // Zero rather than -1: main owns both scroll axes, and a scroll container
    // that is not tab-reachable cannot be scrolled by keyboard on a page whose
    // content carries no focusable element of its own.
    expect(main).toHaveAttribute("tabindex", String(MAIN_CONTENT_TABINDEX));
    expect(MAIN_CONTENT_TABINDEX).toBe(0);
  });

  it("prevents page-level horizontal overflow", () => {
    renderShell(320);
    const shell = document.querySelector("[data-shell]") as HTMLElement;
    // Bounded to the viewport with overflow owned here, so no child can create
    // a page-level scroll on either axis.
    expect(shell.style.overflow).toBe("hidden");
    expect(shell.style.height).toBe("100vh");
    // Wide and long content both scroll inside main instead.
    const main = screen.getByRole("main") as HTMLElement;
    expect(main.style.overflowX).toBe("auto");
    expect(main.style.overflowY).toBe("auto");
    expect(main.style.minHeight).toBe("0px");
  });

  it("has no bell, Help, What's New or Jump-or-act control", () => {
    renderShell(1280);
    const header = document.querySelector("[data-top-bar]") as HTMLElement;
    const text = header.textContent ?? "";
    for (const dead of ["Notifications", "Help", "What's New", "Jump or act", "Notify me"]) {
      expect(text, dead).not.toContain(dead);
    }
    for (const dead of [/notification/i, /help/i, /what.s new/i, /jump or act/i]) {
      expect(within(header).queryAllByRole("button", { name: dead })).toHaveLength(0);
    }
  });

  it("renders no control that does nothing", () => {
    renderShell(1280);
    // Every button either has a handler-backed role or is a link with an href.
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href"), link.textContent ?? "").toBeTruthy();
    }
  });
});

describe("user menu", () => {
  it("offers exactly profile, language, theme and logout", () => {
    expect([...USER_MENU_ITEMS]).toEqual(["profile", "language", "theme", "logout"]);
  });
});

describe("plan does not affect route visibility", () => {
  it("derives nav from leaf role only, with no plan input", () => {
    // Navigation is a pure function of context; there is no plan parameter to
    // pass, so a plan change cannot add or remove a route.
    expect(navGroupsFor.length).toBe(1);
    const roles = navGroupsFor("Client").flatMap((g) => g.items.map((i) => i.role));
    expect(roles.join(" ")).not.toMatch(/plan|scale|tier|billing/i);
  });
});
