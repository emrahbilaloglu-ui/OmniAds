import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeV3LabelChips } from "@/components/creatives/CreativeV3LabelChips";
import { LABEL_DISPLAY } from "@/components/creatives/decision-label-display";
import type { DecisionLabel } from "@/lib/creative-decision-engine/types";

type TestElementProps = {
  children?: React.ReactNode;
  onClick?: () => void;
  "aria-pressed"?: boolean;
};

type TestElement = React.ReactElement<TestElementProps>;

function textContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (React.isValidElement(node)) {
    return textContent((node as TestElement).props.children);
  }
  return "";
}

function collectElements(
  node: React.ReactNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectElements(child, predicate));
  }
  if (!React.isValidElement(node)) return [];

  const element = node as TestElement;
  const children = collectElements(element.props.children, predicate);
  return predicate(element) ? [element, ...children] : children;
}

function renderElement(
  props: Partial<React.ComponentProps<typeof CreativeV3LabelChips>> = {},
) {
  return CreativeV3LabelChips({
    counts: { scale: 2, cut: 1 },
    selected: new Set(),
    onToggle: vi.fn(),
    onClearAll: vi.fn(),
    visible: true,
    ...props,
  });
}

function findButtonByText(node: React.ReactNode, text: string): TestElement {
  const match = collectElements(
    node,
    (element) => element.type === "button" && textContent(element).trim() === text,
  )[0];
  expect(match).toBeDefined();
  return match;
}

describe("CreativeV3LabelChips", () => {
  it("renders nothing when visible=false even with counts present", () => {
    const html = renderToStaticMarkup(
      renderElement({ visible: false, counts: { scale: 8 } }),
    );

    expect(html).toBe("");
  });

  it("renders only chips with count > 0", () => {
    const html = renderToStaticMarkup(
      renderElement({
        counts: {
          scale: 8,
          cut: 0,
          out_of_scope: 2,
        },
      }),
    );

    expect(html).toContain("Scale (8)");
    expect(html).toContain("Out of scope (2)");
    expect(html).not.toContain("Cut (0)");
  });

  it("formats chip text from LABEL_DISPLAY", () => {
    const label: DecisionLabel = "test_more";
    const html = renderToStaticMarkup(
      renderElement({ counts: { [label]: 3 } }),
    );

    expect(html).toContain(`${LABEL_DISPLAY[label].label} (3)`);
  });

  it("clicking a chip calls onToggle with the right label", () => {
    const onToggle = vi.fn();
    const element = renderElement({ counts: { cut: 4 }, onToggle });
    const cutButton = findButtonByText(element, "Cut (4)");

    cutButton.props.onClick?.();

    expect(onToggle).toHaveBeenCalledWith("cut");
  });

  it("sets aria-pressed for active and inactive chips", () => {
    const element = renderElement({
      counts: { scale: 2, cut: 1 },
      selected: new Set<DecisionLabel>(["scale"]),
    });

    expect(findButtonByText(element, "Scale (2)").props["aria-pressed"]).toBe(
      true,
    );
    expect(findButtonByText(element, "Cut (1)").props["aria-pressed"]).toBe(
      false,
    );
  });

  it("only renders Clear when a label is selected and calls onClearAll", () => {
    expect(renderToStaticMarkup(renderElement())).not.toContain("Clear");

    const onClearAll = vi.fn();
    const element = renderElement({
      selected: new Set<DecisionLabel>(["scale"]),
      onClearAll,
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Clear");
    findButtonByText(element, "Clear").props.onClick?.();
    expect(onClearAll).toHaveBeenCalledOnce();
  });
});
