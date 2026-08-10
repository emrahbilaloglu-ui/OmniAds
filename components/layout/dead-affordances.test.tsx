import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveGlobalSearchShortcut } from "@/components/layout/GlobalSearch";

/**
 * Controls that look like they work.
 *
 * Two on the platform menu did not. "Notify me" wrote a line to the browser
 * console — an operator who clicked it believed they had registered interest
 * in TikTok and would hear when it shipped, and nothing recorded that anywhere.
 * A "⌘K" hint sat in the same menu with no handler behind it, and it was in
 * the wrong menu besides: the shortcut belongs to search, not to switching
 * platform.
 *
 * The fix for the first is removal, not a fabricated backend. The fix for the
 * second is to make the shortcut real and put the hint where it applies.
 */
const platformSwitcher = readFileSync(
  "components/layout/PlatformSwitcher.tsx",
  "utf8",
);
const globalSearch = readFileSync(
  "components/layout/GlobalSearch.tsx",
  "utf8",
);

describe("the platform menu offers nothing it cannot do", () => {
  it("no longer offers Notify me", () => {
    expect(
      platformSwitcher.includes("Notify me"),
      "the menu offers to notify someone and only writes to the console",
    ).toBe(false);
  });

  it("logs nothing to the console in place of a feature", () => {
    expect(platformSwitcher).not.toContain("console.info");
  });

  it("does not advertise a shortcut it does not own", () => {
    expect(
      platformSwitcher.includes("⌘K"),
      "the platform menu shows a search shortcut hint",
    ).toBe(false);
  });
});

describe("the search shortcut is real", () => {
  it("shows its hint on the search control itself", () => {
    expect(globalSearch).toMatch(/⌘K|Ctrl K|CtrlK/);
  });

  it("opens on Cmd+K and on Ctrl+K", () => {
    expect(
      resolveGlobalSearchShortcut({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        target: "body",
      }),
    ).toBe("open");
    expect(
      resolveGlobalSearchShortcut({
        key: "k",
        metaKey: false,
        ctrlKey: true,
        target: "body",
      }),
    ).toBe("open");
  });

  it("closes on Escape when open", () => {
    expect(
      resolveGlobalSearchShortcut({
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        target: "body",
        isOpen: true,
      }),
    ).toBe("close");
  });

  it("ignores a bare k", () => {
    // Otherwise typing the letter anywhere would open a dialog.
    expect(
      resolveGlobalSearchShortcut({
        key: "k",
        metaKey: false,
        ctrlKey: false,
        target: "body",
      }),
    ).toBe("ignore");
  });

  it("does not steal the shortcut while someone is composing text", () => {
    // Ctrl+K is a real editing shortcut in inputs and textareas, and IME
    // composition must never be interrupted.
    for (const target of ["input", "textarea", "contenteditable"] as const) {
      expect(
        resolveGlobalSearchShortcut({
          key: "k",
          metaKey: false,
          ctrlKey: true,
          target,
        }),
        `${target} lost its own Ctrl+K`,
      ).toBe("ignore");
    }
    expect(
      resolveGlobalSearchShortcut({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        target: "body",
        isComposing: true,
      }),
    ).toBe("ignore");
  });

  it("still closes on Escape from inside its own input", () => {
    // The one case where the search field must keep the key.
    expect(
      resolveGlobalSearchShortcut({
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        target: "input",
        isOpen: true,
        inOwnField: true,
      }),
    ).toBe("close");
  });

  it("only prevents the default when it actually handled the key", () => {
    // Preventing default on keys it ignores would break normal typing.
    expect(globalSearch).toContain("preventDefault");
    expect(globalSearch).toMatch(/action === "open"|=== "open"/);
  });
});
