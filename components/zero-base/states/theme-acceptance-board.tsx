"use client";

/**
 * Dark-theme acceptance board (P08).
 *
 * Every semantic colour, every state and every surface elevation, on one page,
 * so a theme change can be checked in one look rather than by remembering what
 * eleven screens used to look like.
 *
 * The point is not the swatches. It is that each sample states its meaning in
 * words as well as colour: a board of unlabelled chips proves the tokens
 * resolve, not that a user could tell danger from warning. Contrast regressions
 * hide in exactly that gap.
 */
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const SEMANTIC = [
  { token: "--ledger-semantic-ok", label: "OK", meaning: "Confirmed by a read-back." },
  { token: "--ledger-semantic-warn", label: "Warning", meaning: "Incomplete, or stale." },
  { token: "--ledger-semantic-danger", label: "Danger", meaning: "Unavailable, or destructive." },
  { token: "--ledger-accent-action", label: "Action", meaning: "A control the actor can operate." },
];

const SURFACES = [
  { token: "--ledger-bg-surface", label: "Surface", meaning: "Cards, tables, overlays." },
  { token: "--ledger-bg-inset", label: "Inset", meaning: "The context bar and wells." },
  { token: "--ledger-border-subtle", label: "Subtle border", meaning: "Separators." },
  { token: "--ledger-border-control", label: "Control border", meaning: "Inputs and buttons." },
];

function Swatch({ token, label, meaning }: { token: string; label: string; meaning: string }) {
  return (
    <li data-swatch={token} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span
        aria-hidden="true"
        style={{
          width: 24,
          height: 24,
          flex: "0 0 24px",
          borderRadius: 4,
          background: `var(${token})`,
          border: "1px solid var(--ledger-border-control)",
        }}
      />
      <span style={{ fontSize: 12, lineHeight: "18px" }}>
        {/* The word carries the meaning; the colour only reinforces it. */}
        <strong style={{ fontWeight: 600 }}>{label}</strong>
        <span style={{ display: "block", color: "var(--ledger-ink-secondary)" }}>{meaning}</span>
      </span>
    </li>
  );
}

export function ThemeAcceptanceBoard() {
  const copy = useCopy();
  return (
    <section data-el="dark-board" aria-label={copy.themeAcceptance}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        {copy.themeAcceptance}
      </h1>
      <p style={{ margin: "4px 0 12px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
        {copy.themeAcceptanceNote}
      </p>
      <ZeroBaseTabs
        label={copy.themeAcceptance}
        value="semantic"
        onValueChange={() => {}}
        tabs={[
          {
            id: "semantic",
            label: copy.semanticColours,
            content: (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
                {SEMANTIC.map((entry) => (
                  <Swatch key={entry.token} {...entry} />
                ))}
              </ul>
            ),
          },
          {
            id: "surfaces",
            label: copy.surfaces,
            content: (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
                {SURFACES.map((entry) => (
                  <Swatch key={entry.token} {...entry} />
                ))}
              </ul>
            ),
          },
        ]}
      />
    </section>
  );
}
