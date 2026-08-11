"use client";

/**
 * Economics context (H03), with its sources and consumers named.
 *
 * The panel exists because two different economics sources are in play and a
 * number shown without its source invites the wrong conclusion. Break-even and
 * target ROAS come from the Commercial Truth target pack and are consumed by
 * Meta decisions; Overview and Google read a separate cost model. Both are
 * stated here, and ECON-04 links to the panel that shows them side by side.
 */
import Link from "next/link";

import {
  economicsPanelHref,
  formatRoas,
  type EconomicsContextModel,
} from "@/lib/zero-base/home/economics-context";

export function EconomicsContext({
  model,
  businessId,
}: {
  model: EconomicsContextModel;
  businessId: string | null;
}) {
  const pack = model.sources.find((source) => source.key === "target-pack");
  const cost = model.sources.find((source) => source.key === "cost-model");

  return (
    <section
      data-economics-context=""
      aria-label="Economics context"
      style={{
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-subtle)",
        background: "var(--ledger-bg-surface)",
        padding: 16,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>
        Economics context
      </h2>
      <p style={{ margin: 0, fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-secondary)" }}>
        Break-even ROAS{" "}
        <strong data-econ-break-even={String(model.breakEvenRoas ?? "")}>
          {formatRoas(model.breakEvenRoas)}
        </strong>{" "}
        · target{" "}
        <strong data-econ-target={String(model.targetRoas ?? "")}>
          {formatRoas(model.targetRoas)}
        </strong>{" "}
        from {pack?.label ?? "the target pack"} — consumed by{" "}
        {pack ? pack.consumers.join(", ") : "Meta decisions"}.{" "}
        {cost ? `${cost.consumers.join(" & ")} read the separate ${cost.label}.` : null}{" "}
        <Link
          href={economicsPanelHref(businessId)}
          data-ctl="live:ECON-04 divergence-link"
          data-econ-diverges={model.diverges ? "true" : "false"}
          style={{ color: "var(--ledger-accent-primary)" }}
        >
          See consumers →
        </Link>
      </p>
    </section>
  );
}
