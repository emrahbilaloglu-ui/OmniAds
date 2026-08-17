"use client";

/**
 * The v2 Reports screen, rendered exactly as designed: three tabs (my
 * reports, templates, builder) and a builder laid out as palette / canvas /
 * inspector.
 *
 * This component fetches nothing and decides nothing. It takes a view model
 * and a handler bag, which is what lets the screen's structure be asserted in
 * a unit test and its figures be asserted in the adapter's test.
 */
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";

import styles from "@/components/reports/ReportsExact.module.css";
import {
  AiGeometry,
  BriefGeometry,
  DonutGeometry,
  FunnelGeometry,
  HeatGeometry,
  KpiRowGeometry,
} from "@/components/reports/report-block-geometry";
import type {
  BuilderBlockModel,
  BuilderInspectorModel,
  ReportsExactHandlers,
  ReportsExactModel,
} from "@/components/reports/reports-exact-model";

export type { ReportsExactModel, ReportsExactHandlers } from "@/components/reports/reports-exact-model";

const DASH = "—";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

function BlockBody({ block }: { block: BuilderBlockModel }) {
  const body = block.body;
  switch (body.kind) {
    case "kpi":
      return (
        <>
          <p className={styles.kpiValue}>{body.value}</p>
          <p className={styles.kpiDelta} style={{ color: body.deltaTone }}>
            {body.delta} <span className={styles.kpiDeltaNote}>vs prev</span>
          </p>
        </>
      );
    case "kpirow":
      return <KpiRowGeometry minis={body.minis} />;
    case "line":
      return (
        <svg viewBox="0 0 100 26" preserveAspectRatio="none" className={styles.lineChart}>
          <path d={body.area} fill="rgba(47,107,255,0.08)" stroke="none" />
          <path
            d={body.path}
            fill="none"
            stroke="#2F6BFF"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
    case "bar":
      return (
        <div className={styles.barChart}>
          {body.bars.map((bar, index) => (
            <span
              key={index}
              className={classNames(styles.bar, bar.accent && styles.barAccent)}
              style={{ height: bar.height }}
            />
          ))}
        </div>
      );
    case "donut":
      return <DonutGeometry gradient={body.gradient} legend={body.legend} />;
    case "table":
      return (
        <div className={styles.tableSchematic}>
          <div className={styles.tableSchematicRow}>
            <span className={styles.tableHeadCell} style={{ width: "34%" }} />
            <span className={styles.tableHeadCell} style={{ width: "18%" }} />
            <span className={styles.tableHeadCell} style={{ width: "14%" }} />
          </div>
          {body.rows.map((width, index) => (
            <div className={styles.tableSchematicRow} key={index}>
              <span className={styles.tableBodyLead} style={{ width }} />
              <span className={styles.tableBodyCell} style={{ width: "16%" }} />
              <span className={styles.tableBodyCell} style={{ width: "12%" }} />
            </div>
          ))}
        </div>
      );
    case "text":
      return (
        <div className={styles.textSchematic}>
          <span className={styles.textSchematicLine} style={{ width: "96%" }} />
          <span className={styles.textSchematicLine} style={{ width: "88%" }} />
          <span className={styles.textSchematicLine} style={{ width: "52%" }} />
        </div>
      );
    case "ai":
      return <AiGeometry />;
    case "funnel":
      return <FunnelGeometry steps={[]} />;
    case "heat":
      return <HeatGeometry cells={[]} />;
    case "brief":
      return <BriefGeometry />;
    default:
      return <p className={styles.blockUnavailable}>{DASH}</p>;
  }
}

function Inspector({
  inspector,
  handlers,
}: {
  inspector: BuilderInspectorModel;
  handlers: ReportsExactHandlers;
}) {
  if (inspector.mode === "block") {
    return (
      <article className={styles.inspector}>
        <div className={styles.inspectorHead}>
          <p className={styles.inspectorEyebrow}>Block settings</p>
          <span className={styles.inspectorKind}>{inspector.kindLabel}</span>
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Title</span>
          <input
            className={styles.fieldInput}
            value={inspector.title}
            onChange={(event) => handlers.onInspectorTitleChange(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Metric</span>
          <select
            className={styles.fieldSelect}
            value={inspector.metric}
            onChange={(event) => handlers.onInspectorMetricChange(event.target.value)}
          >
            {inspector.metricOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Source</span>
          <select
            className={styles.fieldSelect}
            value={inspector.source}
            onChange={(event) => handlers.onInspectorSourceChange(event.target.value)}
          >
            {inspector.sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Date range</span>
          <select
            className={styles.fieldSelect}
            value={inspector.dateRange}
            disabled={inspector.dateRangeDisabled}
            onChange={() => undefined}
          >
            {inspector.dateRangeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Width</span>
          <div className={styles.segmented}>
            {inspector.sizeOptions.map((option) => (
              <button
                type="button"
                key={option.size}
                className={classNames(styles.segment, option.active && styles.segmentActive)}
                onClick={() => handlers.onInspectorSizeChange(option.size)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className={styles.checkRow} onClick={handlers.onToggleCompare}>
          <span className={classNames(styles.checkBox, inspector.compareOn && styles.checkBoxOn)}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke={inspector.compareOn ? "#ffffff" : "transparent"}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          <span className={styles.checkLabel}>Show vs previous period</span>
        </button>
        <button type="button" className={styles.removeBlock} onClick={handlers.onRemoveSelected}>
          Remove block
        </button>
        <p className={styles.inspectorFootnote}>{inspector.footnote}</p>
      </article>
    );
  }

  return (
    <article className={styles.inspector}>
      <p className={styles.inspectorEyebrow}>Report settings</p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Client</span>
        <select
          className={styles.fieldSelect}
          value={inspector.client}
          disabled={inspector.clientDisabled}
          onChange={() => undefined}
        >
          {inspector.clientOptions.map((option) => (
            <option key={option.value} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Schedule</span>
        <select
          className={styles.fieldSelect}
          value={inspector.schedule}
          disabled={inspector.scheduleDisabled}
          onChange={() => undefined}
        >
          {inspector.scheduleOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Recipients</span>
        <div className={styles.recipientList}>
          {inspector.recipients.map((recipient) => (
            <span className={styles.recipient} key={recipient.label}>
              {recipient.label}
              {recipient.removable ? <span className={styles.recipientRemove}>✕</span> : null}
            </span>
          ))}
          <button type="button" className={styles.recipientAdd} disabled={inspector.recipientsDisabled}>
            + add
          </button>
        </div>
      </div>
      <div className={styles.toggleRow}>
        <button
          type="button"
          className={classNames(styles.toggle, inspector.liveShareOn && styles.toggleOn)}
          disabled={inspector.liveShareDisabled}
          aria-pressed={inspector.liveShareOn}
          aria-label="Live share link"
        >
          <span className={styles.toggleKnob} />
        </button>
        <span className={styles.checkLabel}>Live share link</span>
        <span className={styles.toggleNote}>{inspector.liveShareRole}</span>
      </div>
      <div className={styles.inspectorHint}>
        <p className={styles.inspectorHintText}>{inspector.hint}</p>
      </div>
    </article>
  );
}

export function ReportsExact({
  model,
  handlers,
}: {
  model: ReportsExactModel;
  handlers: ReportsExactHandlers;
}) {
  const allowDrop = (event: DragEvent) => event.preventDefault();

  return (
    <div className={styles.root} data-screen-label="Reports">
      <section className={styles.section}>
        <div className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>{model.eyebrow}</p>
            <h1 className={styles.title}>{model.title}</h1>
          </div>
          <button type="button" className={styles.newReport} onClick={handlers.onNewReport}>
            {model.newReportLabel}
          </button>
        </div>

        <div className={styles.tabRow}>
          {model.tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              aria-pressed={tab.active}
              className={classNames(styles.tab, tab.active && styles.tabActive)}
              onClick={() => handlers.onSelectTab(tab.id)}
            >
              {tab.label}
              <span className={styles.tabCount}>{tab.count}</span>
            </button>
          ))}
          <span className={styles.spacer} />
          <span className={styles.exportNote}>{model.exportNote}</span>
        </div>

        {model.activeTab === "mine" ? (
          <>
            {/* The reference draws no empty state for this list: with no saved
                reports the article is simply empty, and the tab's own counter
                already reads 0. */}
            <article className={styles.savedList}>
              {model.mine.reports.map((report) => (
                  <div className={styles.savedRow} key={report.id}>
                    <div className={styles.savedThumb}>
                      <span className={styles.savedThumbHead} style={{ background: report.thumbTone }} />
                      <span className={styles.savedThumbCell} />
                      <span className={styles.savedThumbCell} />
                      <span className={styles.savedThumbFoot} />
                    </div>
                    <div className={styles.savedBody}>
                      <div className={styles.savedTitleRow}>
                        <p className={styles.savedName}>{report.name}</p>
                        <span
                          className={styles.savedStatus}
                          style={{ background: report.statusBg, color: report.statusFg }}
                        >
                          {report.status}
                        </span>
                      </div>
                      <p className={styles.savedDesc}>{report.description}</p>
                      <p className={styles.savedMeta}>{report.meta}</p>
                    </div>
                    <div className={styles.savedActions}>
                      <button
                        type="button"
                        className={styles.rowActionPrimary}
                        onClick={() => handlers.onOpenReport(report.id)}
                      >
                        Open in builder
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={report.busy}
                        onClick={() => handlers.onDuplicateReport(report.id)}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={report.busy}
                        onClick={() => handlers.onShareReport(report.id)}
                      >
                        Share link
                      </button>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={() => handlers.onExportReportPdf(report.id)}
                      >
                        PDF
                      </button>
                    </div>
                  </div>
              ))}
            </article>
            <p className={styles.footnote}>{model.mine.footnote}</p>
          </>
        ) : null}

        {model.activeTab === "templates" ? (
          <>
            <div className={styles.templateGrid}>
              {model.templates.cards.map((template) => (
                <article className={styles.templateCard} key={template.id}>
                  <div className={styles.templatePreview}>
                    {template.blocks.map((block, index) => (
                      <span
                        key={index}
                        className={styles.templatePreviewBlock}
                        style={{
                          height: block.height,
                          background: block.background,
                          gridColumn: `span ${block.span}`,
                        }}
                      />
                    ))}
                  </div>
                  <div className={styles.templateMetaRow}>
                    <span
                      className={styles.templateCategory}
                      style={{ background: template.categoryBg, color: template.categoryFg }}
                    >
                      {template.category}
                    </span>
                    <span className={styles.templateCadence}>{template.cadence}</span>
                  </div>
                  <div>
                    <p className={styles.templateName}>{template.name}</p>
                    <p className={styles.templateDesc}>{template.description}</p>
                  </div>
                  <div className={styles.templateContents}>
                    {template.contents.map((entry) => (
                      <div className={styles.templateContentRow} key={entry.n}>
                        <span className={styles.templateContentIndex}>{entry.n}</span>
                        <span className={styles.templateContentText}>{entry.t}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.templateFooter}>
                    <span className={styles.templateFooterMeta}>{template.meta}</span>
                    <span className={styles.spacer} />
                    <button
                      type="button"
                      className={styles.rowAction}
                      onClick={() => handlers.onPreviewTemplate(template.id)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className={styles.templateUse}
                      onClick={() => handlers.onUseTemplate(template.id)}
                    >
                      Use template
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <p className={styles.footnote}>{model.templates.footnote}</p>
          </>
        ) : null}

        {model.activeTab === "builder" ? (
          <>
            <article className={styles.builderToolbar}>
              <input
                className={styles.builderName}
                value={model.builder.name}
                aria-label="Report name"
                onChange={(event) => handlers.onRenameReport(event.target.value)}
              />
              <select
                className={styles.builderRange}
                aria-label="Report date range"
                value={model.builder.dateRange}
                onChange={(event) => handlers.onChangeDateRange(event.target.value)}
              >
                {model.builder.dateRangeOptions.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className={styles.comparePill}>{model.builder.comparePillLabel}</span>
              <span className={styles.spacer} />
              <span className={styles.builderCounter}>{model.builder.counterLabel}</span>
              {/* The reference's Preview carries no disabled state. A report
                  that has never been saved is saved on the way through, so the
                  control does what it says instead of being greyed out. */}
              <button type="button" className={styles.builderSecondary} onClick={handlers.onPreview}>
                Preview
              </button>
              <button
                type="button"
                className={styles.builderPrimary}
                disabled={!model.builder.saveEnabled}
                onClick={handlers.onSave}
              >
                {model.builder.saveLabel}
              </button>
            </article>

            <div className={styles.builderScroll}>
              <div className={styles.builderGrid}>
                <article className={styles.palette}>
                  <p className={styles.paletteEyebrow}>{model.builder.paletteEyebrow}</p>
                  {model.builder.palette.map((group) => (
                    <div key={group.name}>
                      <p className={styles.paletteGroupName}>{group.name}</p>
                      <div className={styles.paletteItems}>
                        {group.items.map((item) => (
                          <button
                            type="button"
                            key={item.key}
                            draggable
                            title="Drag to the page or click to add"
                            className={styles.paletteItem}
                            onDragStart={() => handlers.onPaletteDragStart(item.key)}
                            onClick={() => handlers.onPaletteAdd(item.key)}
                          >
                            <span className={styles.paletteIcon} style={{ background: item.iconBg }}>
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#ffffff"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d={item.icon} />
                              </svg>
                            </span>
                            <span className={styles.paletteLabel}>{item.label}</span>
                            <span className={styles.paletteSource}>{item.source}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </article>

                <article
                  className={styles.canvas}
                  onDragOver={allowDrop}
                  onDrop={(event) => {
                    event.preventDefault();
                    handlers.onDropEnd();
                  }}
                >
                  <div className={styles.canvasHeader}>
                    <span className={styles.canvasMark} />
                    <span className={styles.canvasName}>{model.builder.name}</span>
                    <span className={styles.canvasMeta}>{model.builder.pageMeta}</span>
                  </div>
                  <div className={styles.canvasFlow}>
                    {model.builder.blocks.map((block) => (
                      <div
                        key={block.uid}
                        role="button"
                        tabIndex={0}
                        draggable
                        data-block-uid={block.uid}
                        className={styles.block}
                        style={{ width: block.widthCss, borderColor: block.borderColor }}
                        onDragStart={() => handlers.onBlockDragStart(block.uid)}
                        onDragOver={allowDrop}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handlers.onBlockDropOn(block.uid);
                        }}
                        onClick={() => handlers.onBlockSelect(block.uid)}
                        onKeyDown={(event: KeyboardEvent) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handlers.onBlockSelect(block.uid);
                          }
                        }}
                      >
                        <div className={styles.blockHeader}>
                          <span className={styles.blockHandle} title="Drag to reorder">
                            ⠿
                          </span>
                          <span className={styles.blockTitle}>{block.title}</span>
                          <button
                            type="button"
                            className={styles.blockSize}
                            title="Cycle width S → M → L"
                            onClick={(event) => {
                              stop(event);
                              handlers.onBlockCycleSize(block.uid);
                            }}
                          >
                            {block.sizeLabel}
                          </button>
                          <button
                            type="button"
                            className={styles.blockRemove}
                            title="Remove block"
                            aria-label={`Remove ${block.title}`}
                            onClick={(event) => {
                              stop(event);
                              handlers.onBlockRemove(block.uid);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                        <BlockBody block={block} />
                        <p className={styles.blockSourceNote}>{block.sourceNote}</p>
                      </div>
                    ))}
                    <div
                      className={styles.dropZone}
                      onDragOver={allowDrop}
                      onDrop={(event) => {
                        event.preventDefault();
                        handlers.onDropEnd();
                      }}
                    >
                      <p className={styles.dropZoneText}>{model.builder.dropHint}</p>
                    </div>
                  </div>
                </article>

                <Inspector inspector={model.builder.inspector} handlers={handlers} />
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
