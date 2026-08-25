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
import Link from "next/link";

const REASON_TEXT = {
  "mode-off": "This workspace is currently rolled back to the previous console.",
  "not-enabled": "The new console is not switched on for this workspace yet.",
} as const;

export function RolledBackSurface({
  appPath,
  reason,
}: {
  appPath: string;
  reason: "mode-off" | "not-enabled";
}) {
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
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
        This screen is not available in the previous console
      </h1>
      <p role="status" style={{ margin: 0 }}>
        {REASON_TEXT[reason]} This particular screen was introduced with the new
        console, so there is no earlier version of it to show you — rather than
        send you to a different screen that would answer a different question.
      </p>
      <p style={{ margin: 0 }}>
        Everything that existed before is still where it was.{" "}
        <Link href="/overview" data-ctl="live:ROLLBACK-01 overview">
          Go to Overview
        </Link>
        .
      </p>
    </main>
  );
}
