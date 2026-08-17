import type { IntegrationProvider } from "@/store/integrations-store";

/**
 * View model for the Integrations screen (design lines 2815-2879, model 4315-4353).
 *
 * The design draws exactly four children inside a live card — header row,
 * description, the single first-sync block, footer row — and exactly one button.
 * This model carries nothing else, so the component cannot grow a fifth slot.
 */

/** The four fixed stages of `syncSteps` (design 4323-4330). */
export type IntegrationsFirstSyncStepState = "done" | "current" | "pending";

export interface IntegrationsFirstSyncStepModel {
  key: string;
  /** Authorize · Fetch entities · Backfill 28 days · Validate & snapshot */
  label: string;
  /** The design's note column: the stage hint while current, "done" once past, "" ahead. */
  note: string;
  state: IntegrationsFirstSyncStepState;
}

export interface IntegrationsFirstSyncModel {
  /** Rounded percent as the design renders it, e.g. "42%". */
  percentLabel: string;
  /** Bar width as a CSS length, e.g. "42%". */
  barWidth: string;
  /** design 4344: the bar turns #0E9F6E at 100, #2F6BFF below it. */
  complete: boolean;
  steps: IntegrationsFirstSyncStepModel[];
}

export type IntegrationsStatusTone =
  | "connected"
  | "connecting"
  | "attention"
  | "neutral";

export type IntegrationsButtonKind = "connect" | "manage";

export interface IntegrationsButtonModel {
  /** design 4346: "Manage" when connected, "Connect" when not. */
  caption: string;
  kind: IntegrationsButtonKind;
}

export interface IntegrationsCardModel {
  provider: IntegrationProvider;
  /** design 4315-4321 `integBase[].name`. */
  name: string;
  logoSrc: string | null;
  /** design 4315-4321 `integBase[].desc` — fixed UI copy, not provider data. */
  description: string;
  /** design 4341 `status`. */
  status: string;
  statusTone: IntegrationsStatusTone;
  /** design 4343 `syncing` — drives both the block and the #CBD9FF border. */
  syncing: boolean;
  firstSync: IntegrationsFirstSyncModel | null;
  /** design 4342 `meta` — the one monospace footer line. */
  meta: string;
  /** design 4345 `showBtn` — null renders no button at all. */
  button: IntegrationsButtonModel | null;
}

export interface IntegrationsSoonCardModel {
  provider: IntegrationProvider;
  name: string;
  logoSrc: string | null;
  /** design 4349-4353 `eta`. "—" when no roadmap source serves a date. */
  eta: string;
}

export interface IntegrationsExactModel {
  cards: IntegrationsCardModel[];
  soonCards: IntegrationsSoonCardModel[];
}
