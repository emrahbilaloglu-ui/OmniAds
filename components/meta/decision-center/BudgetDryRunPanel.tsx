"use client";

import type { MetaBudgetDryRunPanel as PanelModel } from "@/lib/meta/budget-dry-run-panel";
import styles from "./MetaDecisionCenterExact.module.css";

/**
 * Renders the server-owned budget dry run verbatim.
 *
 * This component computes NOTHING: no buyer action, no role, no threshold, no
 * eligibility, no current or proposed budget, no provider state and no blocker.
 * Every string it shows was written by the server.
 *
 * It keeps the four layers visibly apart — observed, proposed, simulated,
 * required — because a reader who cannot tell a simulated receipt from a real
 * one has been given a false result. The only control it renders is disabled
 * and says so.
 */
function FactList({ facts, el }: { facts: PanelModel["observed"]["facts"]; el: string }) {
  if (facts.length === 0) return null;
  return (
    <dl className={styles.provenanceGrid} data-el={el}>
      {facts.map((f) => (
        <div key={f.label} data-el={`${el}-fact`} data-label={f.label}>
          <dt className={styles.provenanceFact}>{f.label}</dt>
          <dd className={styles.provenanceFact}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BudgetDryRunPanel({ panel }: { panel: PanelModel | null }) {
  // A missing panel renders nothing at all. An empty state here would read as
  // "nothing is blocking", which is the opposite of the truth.
  if (!panel) return null;

  return (
    <section
      className={styles.provenanceGroup}
      data-el="budget-dry-run"
      data-status={panel.status}
      data-contract={panel.contractVersion}
    >
      <p className={styles.provenanceHeading} data-el="dry-run-headline">
        Budget dry run
      </p>
      <p className={styles.provenanceFact} data-el="dry-run-summary">
        {panel.headline}
      </p>

      {panel.status === "unavailable" ? (
        <p
          className={styles.provenanceFact}
          data-el="dry-run-unavailable"
          data-reason={panel.unavailableReason ?? "unknown"}
        >
          Reason: {panel.unavailableReason ?? "unknown"} — {panel.required.note}
        </p>
      ) : null}

      {/* 1. OBSERVED — what the provider and warehouse actually say. */}
      <p className={styles.provenanceHeading} data-el="dry-run-observed-title">
        {panel.observed.title}
      </p>
      <p className={styles.provenanceFact} data-el="dry-run-observed-note">
        {panel.observed.note}
      </p>
      <FactList facts={panel.observed.facts} el="dry-run-observed" />

      {/* 2. PROPOSED — the exact would-have-sent request, if any. */}
      <p className={styles.provenanceHeading} data-el="dry-run-proposed-title">
        {panel.proposed.title}
      </p>
      <p
        className={styles.provenanceFact}
        data-el="dry-run-proposed-note"
        data-available={String(panel.proposed.available)}
      >
        {panel.proposed.note}
      </p>
      <FactList facts={panel.proposed.facts} el="dry-run-proposed" />

      {/* 3. SIMULATED — a preview receipt, never a durable one. */}
      <p className={styles.provenanceHeading} data-el="dry-run-simulated-title">
        {panel.simulated.title}
      </p>
      <p
        className={styles.provenanceFact}
        data-el="dry-run-simulated-note"
        data-available={String(panel.simulated.available)}
      >
        {panel.simulated.note}
      </p>
      <FactList facts={panel.simulated.facts} el="dry-run-simulated" />

      {/* 4. REQUIRED — the exact gap to an executable change. */}
      <p className={styles.provenanceHeading} data-el="dry-run-required-title">
        {panel.required.title}
      </p>
      {panel.required.blockers.map((b) => (
        <p
          key={b.code}
          className={styles.provenanceFact}
          data-el="dry-run-blocker"
          data-code={b.code}
        >
          {b.code}: {b.why}
        </p>
      ))}
      {panel.required.writeSafetyMissing.length > 0 ? (
        <p className={styles.provenanceFact} data-el="dry-run-write-safety-missing">
          Write-safety steps still missing: {panel.required.writeSafetyMissing.join(", ")}
        </p>
      ) : null}
      <p className={styles.provenanceFact} data-el="dry-run-readback-requirement">
        {panel.required.readbackRequirement}
      </p>

      {/* Execution posture, stated rather than implied. */}
      <p
        className={styles.provenanceFact}
        data-el="dry-run-execution"
        data-execution-state={panel.execution.executionState}
        data-executable={String(panel.execution.executable)}
        data-provider-write-attempted={String(panel.execution.providerWriteAttempted)}
        data-provider-outcome={panel.execution.providerOutcome}
        data-readback={panel.execution.readbackClassification}
      >
        Execution state: {panel.execution.executionState} · provider write attempted:{" "}
        {String(panel.execution.providerWriteAttempted)} · provider outcome:{" "}
        {panel.execution.providerOutcome} · read-back: {panel.execution.readbackClassification}
      </p>
      <p className={styles.provenanceFact} data-el="dry-run-next-requirement">
        Next requirement: {panel.execution.nextRequirement}
      </p>

      {/*
        The only control. It is disabled, it says why, and it carries no
        handler at all — there is nothing it could dispatch.
      */}
      <button
        type="button"
        disabled
        data-el="dry-run-cta"
        data-cta-enabled={String(panel.execution.ctaEnabled)}
      >
        {panel.execution.ctaLabel}
      </button>

      <p className={styles.provenanceFact} data-el="dry-run-fingerprints">
        input {panel.fingerprints.input || "none"} · policy {panel.fingerprints.policy || "none"} ·
        preflight {panel.fingerprints.preflight ?? "none"}
      </p>
    </section>
  );
}
