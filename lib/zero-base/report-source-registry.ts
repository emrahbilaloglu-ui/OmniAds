/**
 * Report Builder source catalog.
 *
 * Five sources render today; four are catalog-only. Search Console and Klaviyo
 * are separate rows and must never be merged into one.
 */
import {
  GENERATED_REPORT_SOURCES,
  type ReportSourceId,
} from "@/lib/zero-base/generated-contracts";

export type { ReportSourceId };

export const REPORT_SOURCES = GENERATED_REPORT_SOURCES;

export const RENDERABLE_SOURCE_IDS: readonly ReportSourceId[] = REPORT_SOURCES.filter(
  (source) => source.kind === "renderable",
).map((source) => source.id);

export const COMING_SOON_SOURCE_IDS: readonly ReportSourceId[] = REPORT_SOURCES.filter(
  (source) => source.kind === "coming_soon",
).map((source) => source.id);

export function isRenderableReportSource(id: string): id is ReportSourceId {
  return (RENDERABLE_SOURCE_IDS as readonly string[]).includes(id);
}
