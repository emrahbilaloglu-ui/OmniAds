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
  BULK_WITHHELD_REASON,
  TEMPLATE_IMMUTABILITY_NOTE,
  WHAT_DOES_NOT_EXIST,
  WHAT_WORKS_TODAY,
  disabledLaunchActions,
  firstBlockingField,
  type ValidationFinding,
} from "@/lib/zero-base/launchpad/launchpad-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface LaunchpadTemplate {
  id: string;
  name: string;
  createdAt: string;
}

export function LaunchpadView({
  templates,
  drafts,
  findings,
  error,
  onCreateDraft,
  onValidate,
  onDuplicateTemplate,
  onDeleteTemplate,
}: {
  templates: readonly LaunchpadTemplate[];
  drafts: readonly { id: string; name: string; createdAt?: string }[];
  findings: readonly ValidationFinding[];
  error?: string | null;
  onCreateDraft?: (name: string, payload: Record<string, unknown>) => void;
  onValidate?: (payload: Record<string, unknown>) => void;
  onDuplicateTemplate?: (id: string, name: string) => void;
  onDeleteTemplate?: (id: string) => void;
}) {
  const copy = useCopy();
  const actions = disabledLaunchActions();
  const [draftName, setDraftName] = useState("");
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const blockingField = firstBlockingField(findings);

  return (
    <div data-launchpad-surface="" style={{ display: "grid", gap: 24 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        {copy.metaLaunchpad}
      </h1>

      {error ? (
        <p role="status" data-launchpad-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {error}
        </p>
      ) : null}

      {/* -------------------------------------------------- what works today */}
      <section aria-label={copy.whatWorksToday}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.whatWorksToday}</h2>
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
      <section aria-label={copy.execution}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.launch}</h2>
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

      {/* ---------------------------------------------------------- drafts */}
      <section aria-label={copy.drafts}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.drafts}</h2>
        {drafts.length === 0 ? (
          <p data-drafts="empty" style={{ margin: "4px 0 8px", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
            {copy.noDrafts}
          </p>
        ) : (
          <ul data-drafts="ready" style={{ margin: "6px 0 8px", paddingLeft: 18 }}>
            {drafts.map((draft) => (
              <li key={draft.id} data-draft={draft.id} style={{ fontSize: 12.5 }}>
                {draft.name}
              </li>
            ))}
          </ul>
        )}
        <div style={{ maxWidth: 360 }}>
          <TextInput
            label={copy.newDraftName}
            data-draft-field="draftName"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          data-draft-create=""
          style={{ marginTop: 8 }}
          state={draftName.trim() ? { kind: "enabled" } : { kind: "disabled", reason: "A draft needs a name." }}
          onClick={() => onCreateDraft?.(draftName.trim(), { name: draftName.trim() })}
        >
          {copy.saveDraft}
        </Button>
      </section>

      {/* ----------------------------------------------------- validation */}
      <section aria-label={copy.validation}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.validation}</h2>
        {findings.length === 0 ? (
          <p data-validation="clean" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            {copy.validationSilent}
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
                {copy.goToFirstProblem}
              </Button>
            ) : null}
          </>
        )}
        <div style={{ marginTop: 10, maxWidth: 360 }}>
          <TextInput
            label={copy.adName}
            data-draft-field="name"
            ref={(node) => {
              fieldRefs.current.name = node;
            }}
          />
        </div>
        <Button
          variant="secondary"
          data-validate-run=""
          style={{ marginTop: 8 }}
          onClick={() => onValidate?.({ name: fieldRefs.current.name?.value ?? "" })}
        >
          {copy.runValidation}
        </Button>
      </section>

      {/* ------------------------------------------------------- templates */}
      <section aria-label={copy.templates}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.templates}</h2>
        <p data-template-note="" style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {TEMPLATE_IMMUTABILITY_NOTE}
        </p>
        <DataTable
          caption={copy.launchpadTemplates}
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
                  <Button
                    variant="secondary"
                    data-template-duplicate={row.id}
                    onClick={() => onDuplicateTemplate?.(row.id, `${row.name} (copy)`)}
                  >
                    {copy.duplicate}
                  </Button>
                  <Button variant="danger" data-template-delete={row.id} onClick={() => onDeleteTemplate?.(row.id)}>
                    {copy.deleteItem}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </section>

      {/* ------------------------------------------------------------ bulk */}
      <section aria-label={copy.bulkAdStatus}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.bulkAdStatus}</h2>
        {/* Withheld even when the mutation flag is on: this page cannot build
            the handler's exact per-item contract, and a button that can only
            400 is worse than an absent one. */}
        <p data-bulk-withheld="" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {BULK_WITHHELD_REASON}
        </p>
      </section>

    </div>
  );
}
