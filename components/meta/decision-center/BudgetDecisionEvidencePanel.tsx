"use client";

import type {
  MetaBudgetDecisionEvidenceByDirection,
  MetaBudgetDecisionEvidencePanel as PanelModel,
} from "@/lib/meta/budget-decision-evidence-panel";
import styles from "./MetaDecisionCenterExact.module.css";

/**
 * Renders the server-owned budget-decision evidence verbatim.
 *
 * This component computes NOTHING. It derives no eligibility, no buyer action,
 * no campaign role, no threshold and no spend unit; it does not decide whether
 * a section is clear; and it never enables a call to action. Every sentence and
 * every state it shows was written by the server.
 *
 * A missing panel renders nothing at all — it never implies "nothing is
 * blocking", which is the failure mode an empty state would create.
 */
const SECTION_TITLE: Record<PanelModel["sections"][number]["section"], string> = {
  input_integrity: "Input integrity",
  commercial_target: "Commercial target",
  evidence_floor: "Evidence",
  change_safety: "Change safety",
  execution_capability: "Execution capability",
};

const DIRECTION_TITLE = {
  increase: "If increased",
  decrease: "If decreased",
} as const;

function DirectionPanel({
  direction,
  panel,
  actionFromServer,
}: {
  direction: "increase" | "decrease";
  panel: PanelModel;
  /**
   * Supplied by the server. The component used to hold this mapping as a local
   * constant, so the surface asserted a direction-to-action relationship that
   * no response carried.
   */
  actionFromServer: "scale" | "cut";
}) {
  const lineage = panel.commercialLineage;
  // `resolved` carries no reason or contract fields, so narrow once here
  // rather than asserting inside JSX.
  const unresolved =
    lineage.availability.status === "resolved" ? null : lineage.availability;
  return (
    <section
      className={styles.provenanceGroup}
      data-el="budget-decision-direction"
      data-direction={direction}
      data-status={panel.status}
    >
      <p className={styles.provenanceHeading}>
        {DIRECTION_TITLE[direction]}
        <span data-el="direction-action" data-action={actionFromServer}>
          {" · depends on "}
          {actionFromServer}
        </span>
      </p>

      {panel.status === "unavailable" ? (
        /*
          The server-owned unavailable lineage, rendered verbatim.

          r5 printed one hardcoded generic sentence here and kept the exact
          status, reason, expected contract and observed contract inside the
          resolved-only branch below, so `gate_not_evaluated` — a GATE-level
          cause — never reached the screen, and a buyer could not tell a
          missing verdict from an unsupported gate contract. Nothing in this
          branch is invented: every value comes from `unavailableEvidencePanel`.
        */
        <>
          <p className={styles.provenanceFact} data-el="unavailable-reason" data-reason={panel.unavailableReason}>
            This account&rsquo;s decision gates could not be resolved, so nothing here can be
            acted on. Reason: {panel.unavailableReason}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="commercial-availability"
            data-status={lineage.availability.status}
            data-action={lineage.selectedAction ?? "unknown"}
            data-eligible={lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          >
            {unresolved?.reason ?? "the decision gates could not be resolved"}
          </p>
          <p className={styles.provenanceFact} data-el="commercial-code" data-code={lineage.code ?? "none"}>
            Canonical code: {lineage.code ?? "none"}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="commercial-eligible"
            data-eligible-value={lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          >
            Canonical eligibility: {lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="commercial-contract"
            data-contract={lineage.contractVersion ?? "none"}
            data-source-status={lineage.availability.status}
          >
            Profile contract: {lineage.contractVersion ?? "none"} · source:{" "}
            {lineage.availability.status} · expected{" "}
            {unresolved?.expectedContract ?? "none"}, observed{" "}
            {unresolved?.observedContract ?? "none"}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="execution-readiness"
            data-state={panel.executionReadiness.state}
            data-cta-enabled={String(panel.executionReadiness.ctaEnabled)}
          >
            {panel.executionReadiness.why}
          </p>
        </>
      ) : (
        <>
          <p
            className={styles.provenanceFact}
            data-el="authority"
            data-authority={panel.authority ?? "unknown"}
          >
            {panel.authority === "validated_only" ? "Validated for review only." : "Blocked."}
          </p>

          {/*
            The canonical commercial lineage, rendered verbatim. "The profile
            could not be read" and "the profile says this action is ineligible"
            are different facts and must look different.
          */}
          <p
            className={styles.provenanceFact}
            data-el="commercial-availability"
            data-status={lineage.availability.status}
            data-action={lineage.selectedAction ?? "unknown"}
            data-eligible={lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          >
            {lineage.availability.status === "resolved"
              ? (lineage.reason ??
                (lineage.eligible === true
                  ? `The canonical profile reports ${lineage.selectedAction} eligible.`
                  : `The canonical profile reports ${lineage.selectedAction} ineligible.`))
              : lineage.availability.reason}
          </p>
          {/*
            The exact canonical fields, as visible text. Data attributes alone
            are not proof a buyer can read: r4 rendered the contract only as an
            attribute and re-derived the code from a gate blocker, so an
            eligible action's real code never reached the screen at all.
          */}
          <p className={styles.provenanceFact} data-el="commercial-code" data-code={lineage.code ?? "none"}>
            Canonical code: {lineage.code ?? "none"}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="commercial-eligible"
            data-eligible-value={lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          >
            Canonical eligibility: {lineage.eligible === null ? "unknown" : String(lineage.eligible)}
          </p>
          <p
            className={styles.provenanceFact}
            data-el="commercial-contract"
            data-contract={lineage.contractVersion ?? "none"}
            data-source-status={lineage.availability.status}
          >
            Profile contract: {lineage.contractVersion ?? "none"} · source:{" "}
            {lineage.availability.status}
            {lineage.availability.status === "resolved"
              ? ""
              : ` · expected ${lineage.availability.expectedContract}, observed ${lineage.availability.observedContract ?? "none"}`}
          </p>
          {lineage.anchorExplanation === null ? null : (
            <pre
              className={styles.budgetAnchorExplanation}
              data-el="commercial-anchor-explanation"
              data-contract={lineage.contractVersion ?? "unknown"}
            >
              {JSON.stringify(lineage.anchorExplanation, null, 1)}
            </pre>
          )}

          {/*
            The code and its sentence arrive together from the server.
            Recovering the sentence by section order put a `budget_fact_absent`
            code beside the commercial reason, because section order is not
            blocker order.
          */}
          {panel.primaryBlocker === null ? null : (
            <p
              className={styles.provenanceFact}
              data-el="primary-blocker"
              data-code={panel.primaryBlocker.code}
            >
              {panel.primaryBlocker.reason}
            </p>
          )}

          <ul className={styles.provenanceCapabilities} data-el="sections">
            {panel.sections.map((section) => (
              <li
                className={styles.provenanceCapability}
                data-el="section"
                data-section={section.section}
                data-clear={section.clear ? "true" : "false"}
                key={section.section}
              >
                <span data-el="section-title">{SECTION_TITLE[section.section]}</span>
                {section.clear ? (
                  <span data-el="section-clear"> · clear</span>
                ) : (
                  <ul data-el="section-reasons">
                    {section.blockerCodes.map((code, index) => (
                      <li data-el="section-reason" data-code={code} key={code}>
                        {section.reasons[index] ?? ""}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p
        className={styles.provenanceFact}
        data-el="execution-readiness"
        data-state={panel.executionReadiness.state}
      >
        {panel.executionReadiness.why}
      </p>
      {/*
        Present so the disabled state is visible rather than merely absent, and
        never enabled: this surface has no write path at all.
      */}
      <button data-el="budget-cta" disabled type="button">
        Not executable
      </button>
    </section>
  );
}

export function BudgetDecisionEvidencePanel({
  evidence,
}: {
  evidence: MetaBudgetDecisionEvidenceByDirection | null;
}) {
  if (evidence === null) return null;

  return (
    <section
      className={styles.provenanceGroup}
      data-el="budget-decision-evidence"
      data-meta-exact-source-group="budget-evidence"
      data-direction-selected={evidence.directionSelected ?? "none"}
    >
      <h3 className={styles.provenanceHeading}>Budget decision evidence</h3>
      <p className={styles.provenanceFact} data-el="direction-note">
        {evidence.directionSelectedWhy}
      </p>
      {/*
        Both directions are laid out in one responsive grid: side by side where
        there is room and stacked on a narrow viewport. The rule lives in the
        surface stylesheet with the other provenance layout, so no arithmetic
        or breakpoint logic runs in this component.
      */}
      <div className={styles.budgetEvidenceDirections} data-el="budget-directions">
        <DirectionPanel
          actionFromServer={evidence.directionToAction.increase}
          direction="increase"
          panel={evidence.increase}
        />
        <DirectionPanel
          actionFromServer={evidence.directionToAction.decrease}
          direction="decrease"
          panel={evidence.decrease}
        />
      </div>
    </section>
  );
}
