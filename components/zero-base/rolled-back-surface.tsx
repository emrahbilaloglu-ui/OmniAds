/**
 * A canonical surface asked for while the workspace is rolled back, and there
 * is nothing earlier to show instead.
 *
 * Eight canonical paths never existed before the new console — Account
 * Intelligence, Briefs, the Shares ledger and five others — so the rollback has
 * no preserved body to fall back to. The alternatives were both worse than
 * saying so: redirecting to a neighbouring legacy screen would answer a
 * question about one surface with another surface's data, and a bare 404 would
 * tell an operator the page does not exist when it does and will return.
 *
 * So this states the actual situation, in the operator's terms, and names the
 * screens that ARE available. It grants nothing and reads nothing; it is
 * reached only after the session and the business have already been resolved.
 */
"use client";

import Link from "next/link";

import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function RolledBackSurface({
  appPath,
  reason,
}: {
  appPath: string;
  reason: "mode-off" | "not-enabled";
}) {
  /*
   * Through `copy.ts`, like every other operator-facing string.
   *
   * This screen was written with its sentences inline, which the locale gate
   * correctly refused: an operator who has set the console to Turkish would
   * have been told, in English, that their workspace is rolled back — at the
   * exact moment they are least able to work out what happened. `useCopy`
   * resolves the language from the provider when there is one and from the
   * cookie when there is not, which is why this is a client component.
   */
  const copy = useCopy();
  return (
    <main
      data-rolled-back-surface={appPath}
      data-rolled-back-reason={reason}
      style={{
        display: "grid",
        gap: 10,
        alignContent: "start",
        maxWidth: 640,
        margin: "0 auto",
        padding: "48px 24px",
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{copy.rolledBackTitle}</h1>
      <p role="status" style={{ margin: 0 }}>
        {reason === "mode-off" ? copy.rolledBackModeOff : copy.rolledBackNotEnabled}{" "}
        {copy.rolledBackExplainer}
      </p>
      <p style={{ margin: 0 }}>
        {copy.rolledBackEverythingElse}{" "}
        <Link href="/overview" data-ctl="live:ROLLBACK-01 overview">
          {copy.rolledBackGoToOverview}
        </Link>
        .
      </p>
    </main>
  );
}
