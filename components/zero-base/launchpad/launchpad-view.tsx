"use client";

/**
 * Meta Launchpad preparation (H25/H26).
 *
 * Every disabled control here states its own prerequisites. "Unavailable" with
 * no reason teaches an operator that the product is broken; "unavailable
 * because there is no rollback" teaches them something true.
 */
import { useRef, useState } from "react";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import {
  MAX_BULK_ADS,
  TEMPLATE_IMMUTABILITY_NOTE,
  WHAT_DOES_NOT_EXIST,
  WHAT_WORKS_TODAY,
  disabledLaunchActions,
  firstBlockingField,
  gateBulkRequest,
  type BulkItemOutcome,
  type ValidationFinding,
} from "@/lib/zero-base/launchpad/launchpad-contract";

export interface LaunchpadTemplate {
  id: string;
  name: string;
  createdAt: string;
}

export function LaunchpadView({
  templates,
  findings,
  onDuplicateTemplate,
  onDeleteTemplate,
  bulk,
}: {
  templates: readonly LaunchpadTemplate[];
  findings: readonly ValidationFinding[];
  onDuplicateTemplate?: (id: string) => void;
  onDeleteTemplate?: (id: string) => void;
  /** Absent unless the server enabled the mutation UI. */
  bulk?: {
    candidates: readonly { adId: string; name: string }[];
    onApply: (adIds: string[]) => Promise<BulkItemOutcome[]>;
  };
}) {
  const actions = disabledLaunchActions();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<BulkItemOutcome[] | null>(null);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const blockingField = firstBlockingField(findings);

  return (
    <div data-launchpad-surface="" style={{ display: "grid", gap: 24 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        Meta Launchpad
      </h1>

      {/* -------------------------------------------------- what works today */}
      <section aria-label="What works today">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>What works today</h2>
        <ul data-what-works="" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {WHAT_WORKS_TODAY.map((line) => (
            <li key={line} style={{ fontSize: 12.5, lineHeight: "18px" }}>
              {line}
            </li>
          ))}
        </ul>
        <ul data-what-does-not-exist="" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {WHAT_DOES_NOT_EXIST.map((line) => (
            <li key={line} style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--ledger-semantic-warn)" }}>
              {line}
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------ disabled execution */}
      <section aria-label="Execution">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Launch</h2>
        {actions.map((action) => (
          <div key={action.id} data-launch-action={action.id} style={{ marginTop: 8 }}>
            <Button
              variant="secondary"
              data-launch-disabled={action.id}
              state={{ kind: "disabled", reason: action.summary, code: action.id }}
            >
              {action.label}
            </Button>
            <ul data-launch-prerequisites={action.id} style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {action.prerequisites.map((item) => (
                <li key={item.id} data-prerequisite={item.id} style={{ fontSize: 12, lineHeight: "17px" }}>
                  <strong style={{ fontWeight: 600 }}>{item.label}</strong> — {item.detail}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* ----------------------------------------------------- validation */}
      <section aria-label="Validation">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Validation</h2>
        {findings.length === 0 ? (
          <p data-validation="clean" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            Validation reported nothing for this draft.
          </p>
        ) : (
          <>
            <ul data-validation="findings" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {findings.map((finding) => (
                <li
                  key={finding.id}
                  data-finding={finding.severity}
                  style={{
                    fontSize: 12.5,
                    color:
                      finding.severity === "error"
                        ? "var(--ledger-semantic-danger)"
                        : finding.severity === "warning"
                          ? "var(--ledger-semantic-warn)"
                          : "var(--ledger-ink-secondary)",
                  }}
                >
                  {finding.message}
                </li>
              ))}
            </ul>
            {blockingField ? (
              <Button
                variant="secondary"
                data-validation-focus={blockingField}
                onClick={() => fieldRefs.current[blockingField]?.focus()}
                style={{ marginTop: 8 }}
              >
                Go to the first problem
              </Button>
            ) : null}
          </>
        )}
        <div style={{ marginTop: 10, maxWidth: 360 }}>
          <TextInput
            label="Ad name"
            data-draft-field="name"
            ref={(node) => {
              fieldRefs.current.name = node;
            }}
          />
        </div>
      </section>

      {/* ------------------------------------------------------- templates */}
      <section aria-label="Templates">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Templates</h2>
        <p data-template-note="" style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {TEMPLATE_IMMUTABILITY_NOTE}
        </p>
        <DataTable
          caption="Launchpad templates"
          rows={[...templates]}
          rowKey={(row) => row.id}
          columns={[
            { id: "name", header: "Template", render: (row) => row.name },
            { id: "created", header: "Created", render: (row) => row.createdAt },
            {
              id: "actions",
              header: "Actions",
              // Duplicate and delete only. There is no edit, because the API
              // has no update and a mutable template would change under
              // whatever already used it.
              render: (row) => (
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button variant="secondary" data-template-duplicate={row.id} onClick={() => onDuplicateTemplate?.(row.id)}>
                    Duplicate
                  </Button>
                  <Button variant="danger" data-template-delete={row.id} onClick={() => onDeleteTemplate?.(row.id)}>
                    Delete
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </section>

      {/* ------------------------------------------------------------ bulk */}
      {bulk ? (
        <section aria-label="Bulk ad status">
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Bulk ad status</h2>
          <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            Up to {MAX_BULK_ADS} ads per request.
          </p>
          <div data-bulk-candidates="" style={{ display: "grid", gap: 4 }}>
            {bulk.candidates.map((candidate) => (
              <label key={candidate.adId} style={{ fontSize: 12.5, display: "flex", gap: 6 }}>
                <input
                  type="checkbox"
                  data-bulk-select={candidate.adId}
                  checked={selected.includes(candidate.adId)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, candidate.adId]
                        : current.filter((id) => id !== candidate.adId),
                    )
                  }
                />
                {candidate.name}
              </label>
            ))}
          </div>
          {bulkError ? (
            <p role="status" data-bulk-error="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
              {bulkError}
            </p>
          ) : null}
          <Button
            variant="secondary"
            data-bulk-apply=""
            style={{ marginTop: 8 }}
            onClick={async () => {
              const gate = gateBulkRequest({ mutationUiEnabled: true, adIds: selected });
              if (!gate.ok) {
                setBulkError(gate.reason);
                setOutcomes(null);
                return;
              }
              setBulkError(null);
              setOutcomes(await bulk.onApply(gate.adIds));
            }}
          >
            Apply to selected
          </Button>
          {outcomes ? (
            <ul data-bulk-outcomes="" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {outcomes.map((outcome) => (
                <li key={outcome.adId} data-bulk-outcome={outcome.status} style={{ fontSize: 12.5 }}>
                  {outcome.adId}: {outcome.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
