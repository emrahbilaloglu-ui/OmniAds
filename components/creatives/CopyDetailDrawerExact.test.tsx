// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CopyDetailDrawerExact,
  type CopyDetailDrawerExactViewModel,
} from "./CopyDetailDrawerExact";

afterEach(cleanup);

const CSS = readFileSync(
  join(process.cwd(), "components/creatives/CopyDetailDrawerExact.module.css"),
  "utf8",
);

function viewModel(
  over: Partial<CopyDetailDrawerExactViewModel> = {},
): CopyDetailDrawerExactViewModel {
  return {
    kind: "Primary Text · 24 chars",
    text: "fixture served copy line",
    angle: "—",
    angleTone: "neutral",
    edgeTone: "warning",
    read: "—",
    stats: [
      { id: "see-more", label: "See more", value: "—", sub: "—" },
      { id: "ctr", label: "CTR", value: "1.72%", sub: "median 1.34%" },
      { id: "engage", label: "Engage", value: "—", sub: "—" },
      { id: "roas", label: "ROAS", value: "5.2", sub: "target 3.80", tone: "positive" },
    ],
    alternatesNote: "served with this creative · Meta-reported",
    alternates: [
      {
        id: "alt-1",
        angle: "—",
        angleTone: "neutral",
        text: "fixture alternate",
        why: "—",
        draftHref: "/platforms/meta/launchpad",
      },
    ],
    footnote: "fixture footnote",
    draftAllLabel: "Draft all 1 in Launchpad",
    draftAllHref: "/platforms/meta/launchpad",
    ...over,
  };
}

describe("CopyDetailDrawerExact geometry", () => {
  it("pins the design's 520px aside on the canvas with the 70px shadow", () => {
    expect(CSS).toContain("width: 520px");
    expect(CSS).toContain("background: #f3f5f9");
    expect(CSS).toContain("box-shadow: -28px 0 70px rgba(11, 16, 32, 0.35)");
    expect(CSS).toContain("background: rgba(11, 16, 32, 0.46)");
  });

  it("gives the Read card the design's 3px tone edge", () => {
    expect(CSS).toContain("border-left: 3px solid var(--tone-solid)");
  });

  it("keeps the stat sub-line on the mono face, matching its label", () => {
    expect(CSS).toMatch(/\.statSub \{[^}]*IBM Plex Mono/);
    expect(CSS).toMatch(/\.statLabel \{[^}]*IBM Plex Mono/);
  });

  it("renders the footnote on the mono face at body level", () => {
    expect(CSS).toMatch(/\.footnote \{[^}]*IBM Plex Mono/);
    expect(CSS).toMatch(/\.footnote \{[^}]*font-size: 10px/);
  });

  it("tones the stat value rather than hard-coding one ink", () => {
    expect(CSS).toContain(".statValue.tonePositive");
    expect(CSS).toContain(".statValue.toneNegative");
  });
});

describe("CopyDetailDrawerExact composition", () => {
  it("renders the eyebrow with the asset type and the character count", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(screen.getByText("Copy detail · Primary Text · 24 chars")).toBeInTheDocument();
  });

  it("renders the design's four stat tiles in order", () => {
    const { container } = render(
      <CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />,
    );
    const labels = Array.from(container.querySelectorAll('[class*="statLabel"]')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["See more", "CTR", "Engage", "ROAS"]);
  });

  it("carries the Read card and the alternates card the design defines", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Alternative lines")).toBeInTheDocument();
    expect(screen.getByText("served with this creative · Meta-reported")).toBeInTheDocument();
    expect(screen.getByText("fixture footnote")).toBeInTheDocument();
  });

  it("keeps the design's footer pair", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(
      screen.getByRole("link", { name: "Draft all 1 in Launchpad" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("keeps one em-dashed alternate row when the provider served none", () => {
    const { container } = render(
      <CopyDetailDrawerExact
        onClose={vi.fn()}
        viewModel={viewModel({ alternates: [], draftAllHref: null })}
      />,
    );
    expect(container.querySelector('[data-copy-alternate="none"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Draft all 1 in Launchpad" })).toBeDisabled();
  });

  it("closes on the backdrop, the close glyph, the footer Close and Escape", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CopyDetailDrawerExact onClose={onClose} viewModel={viewModel()} />,
    );
    fireEvent.click(container.querySelector('[data-testid="copy-detail-drawer"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Close copy detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
