import type { PublicShare } from "@/lib/zero-base/creative/public-share";
import type { ShareMetricKey } from "@/components/creatives/shareCreativeTypes";

function csvCell(value: unknown): string {
  const text = value === null || typeof value === "undefined" ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV is built only from the already-sanitized public projection. */
export function buildPublicCreativeShareCsv(share: PublicShare): string {
  const metricOrder = new Map<ShareMetricKey, { label: string; order: number }>();
  for (const creative of share.creatives) {
    for (const metric of creative.metrics) {
      if (!metricOrder.has(metric.key)) {
        metricOrder.set(metric.key, {
          label: metric.label,
          order: metricOrder.size,
        });
      }
    }
  }
  const metrics = [...metricOrder.entries()].sort(
    (left, right) => left[1].order - right[1].order,
  );
  const header = [
    "Creative",
    "Format",
    "Created",
    ...metrics.map(([, metric]) => metric.label),
  ];
  const rows = share.creatives.map((creative) => {
    const values = new Map(
      creative.metrics.map((metric) => [metric.key, metric.rawValue] as const),
    );
    return [
      creative.name,
      creative.format,
      creative.launchDate,
      ...metrics.map(([key]) => values.get(key) ?? ""),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
