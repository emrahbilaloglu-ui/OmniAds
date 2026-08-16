"use client";

/**
 * The design's "Angle coverage" band under the Copies table: which messaging
 * angles the live lines actually cover, and which are untested.
 *
 * Angles are auto-tagged by the engine. Until that tagging ships the rows carry
 * no angle, and this band says so plainly instead of inventing a distribution.
 */
export function CopyAngleCoverage({
  rows,
  currencySymbol,
}: {
  rows: Array<{ copyAngle: string | null; spend?: number | null }>;
  currencySymbol: string;
}) {
  const tagged = rows.filter((row) => Boolean(row.copyAngle));
  const totalSpend = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.spend) ? Number(row.spend) : 0),
    0,
  );

  const byAngle = new Map<string, number>();
  for (const row of tagged) {
    const key = row.copyAngle!;
    byAngle.set(key, (byAngle.get(key) ?? 0) + (Number(row.spend) || 0));
  }
  const ranked = [...byAngle.entries()].sort((left, right) => right[1] - left[1]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[12px] border border-dashed border-[var(--adv-scroll-thumb)] bg-[#FBFCFE] px-[14px] py-[11px]">
      <span className="shrink-0 font-[family-name:var(--adv-font-mono)] text-[9.5px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
        Angle coverage
      </span>

      {tagged.length === 0 ? (
        <p className="m-0 min-w-[240px] flex-1 text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
          No angle is tagged on these lines yet — the engine assigns angles from
          the creative, and this band fills in once that tagging runs.
        </p>
      ) : (
        <>
          <p className="m-0 min-w-[240px] flex-1 text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
            {tagged.length} of {rows.length} live lines sit on {ranked.length} angle
            {ranked.length === 1 ? "" : "s"}
            {ranked.length > 0 && totalSpend > 0
              ? ` — ${ranked[0]![0]} holds ${Math.round((ranked[0]![1] / totalSpend) * 100)}% of spend`
              : ""}
            .
          </p>
          {ranked.map(([angle, spend]) => (
            <span
              key={angle}
              className="inline-flex rounded-md border border-[#DACBF2] bg-[#FDFBFF] px-[9px] py-[3px] text-[11px] font-semibold text-[#6C41BE]"
            >
              {angle}
              <span className="ml-1.5 font-normal opacity-75">
                {currencySymbol}
                {Math.round(spend).toLocaleString()}
              </span>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
