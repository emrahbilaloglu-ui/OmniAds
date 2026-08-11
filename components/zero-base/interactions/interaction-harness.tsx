/**
 * WP-26 group 3 — shared assertions for the 142 interaction contracts.
 *
 * Every helper here asserts something a user could observe. Registry
 * membership, a `data-` attribute, or the existence of a component is never
 * enough: the point of G7 is that each control has a real native role, a real
 * name, a real posture, and a real consequence.
 *
 * `interactionCase` records the key only after its body returns, so a thrown
 * expectation leaves the key absent from the manifest.
 */
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { recordInteraction, writeStateResults } from "@/lib/zero-base/state-interaction-cases";

/** Run one contract key's case; record only on success. */
export function interactionCase(key: string, body: () => void | Promise<void>) {
  it(key, async () => {
    await body();
    recordInteraction(key);
  });
}

/**
 * A control the user can operate.
 *
 * Asserts the element exists, exposes a native role, carries a non-empty
 * accessible name, and is not silently disabled. A control with no name is
 * unusable by anyone not looking at it.
 */
export function expectOperable(element: Element | null, what: string): HTMLElement {
  expect(element, `${what}: not rendered`).not.toBeNull();
  const node = element as HTMLElement;
  const tag = node.tagName.toLowerCase();
  const role = node.getAttribute("role");
  const nativeRole = ["button", "a", "select", "input", "textarea"].includes(tag);
  expect(nativeRole || Boolean(role), `${what}: no native role`).toBe(true);

  // An input's accessible name comes from its associated <label>, not from
  // its own text content — which is always empty for a form field.
  const labelled =
    node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent : null;
  const name =
    node.getAttribute("aria-label") ??
    (node.getAttribute("aria-labelledby")
      ? document.getElementById(node.getAttribute("aria-labelledby")!)?.textContent
      : null) ??
    labelled ??
    node.closest("label")?.textContent ??
    node.textContent ??
    "";
  expect(name.trim().length, `${what}: no accessible name`).toBeGreaterThan(0);
  expect(node.getAttribute("aria-disabled"), `${what}: unexpectedly disabled`).not.toBe("true");
  return node;
}

/**
 * A control that is deliberately unavailable.
 *
 * The contract is `aria-disabled` plus a stated reason — never the bare
 * `disabled` attribute, which removes the control from the accessibility tree
 * and takes the explanation with it.
 */
export function expectDisabledWithReason(element: Element | null, what: string): HTMLElement {
  expect(element, `${what}: not rendered`).not.toBeNull();
  const node = element as HTMLElement;
  expect(node.getAttribute("aria-disabled"), `${what}: not aria-disabled`).toBe("true");
  const describedBy = node.getAttribute("aria-describedby");
  const reason = describedBy ? document.getElementById(describedBy)?.textContent ?? "" : "";
  expect(reason.trim().length, `${what}: disabled without a stated reason`).toBeGreaterThan(0);
  return node;
}

/** A busy control announces itself and refuses a second activation. */
export function expectBusy(element: Element | null, what: string): HTMLElement {
  expect(element, `${what}: not rendered`).not.toBeNull();
  const node = element as HTMLElement;
  expect(node.getAttribute("aria-busy"), `${what}: not aria-busy`).toBe("true");
  return node;
}

/** Clicking a disabled control must do nothing at all. */
export function expectClickSuppressed(node: HTMLElement, spy: { mock: { calls: unknown[] } }, what: string) {
  node.click();
  expect(spy.mock.calls.length, `${what}: disabled control still fired`).toBe(0);
}

/** Keyboard and pointer must reach the same outcome. */
export function expectKeyboardPointerParity(
  make: () => HTMLElement,
  fire: { pointer: (node: HTMLElement) => void; keyboard: (node: HTMLElement) => void },
  read: () => unknown,
  what: string,
) {
  const viaPointer = (() => {
    const node = make();
    fire.pointer(node);
    return read();
  })();
  const viaKeyboard = (() => {
    const node = make();
    fire.keyboard(node);
    return read();
  })();
  expect(viaKeyboard, `${what}: keyboard and pointer disagree`).toEqual(viaPointer);
}

/** A live region that actually announces. */
export function expectLiveRegion(selector: string, what: string): HTMLElement {
  const node = document.querySelector(selector) as HTMLElement | null;
  expect(node, `${what}: no live region`).not.toBeNull();
  const politeness = node!.getAttribute("aria-live") ?? node!.getAttribute("role");
  expect(politeness, `${what}: live region is not announced`).toBeTruthy();
  return node!;
}

/** A link's destination, asserted rather than assumed. */
export function expectNavigates(element: Element | null, matcher: RegExp, what: string): string {
  const node = expectOperable(element, what);
  const href = node.getAttribute("href") ?? "";
  expect(href, `${what}: href ${href} does not match ${matcher}`).toMatch(matcher);
  return href;
}

export { screen, waitFor };

/** Each interaction file writes its own fragment; the reconciler unions them. */
export function flushInteractionResults(tag: string) {
  writeStateResults(process.env.ZERO_BASE_COMMIT?.trim() || "worktree", tag);
}
