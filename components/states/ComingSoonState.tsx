import { PlatformLogo } from "@/components/layout/platform-logo";
import { platformsRegistry, type PlatformId } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

interface ComingSoonStateProps {
  platformId: PlatformId;
  title?: string;
  description?: string;
  status?: "soon" | "beta";
  className?: string;
}

export function ComingSoonState({
  platformId,
  title,
  description,
  status = "soon",
  className,
}: ComingSoonStateProps) {
  const platform = platformsRegistry[platformId];
  const badgeLabel = status === "beta" ? "Beta contract" : "Soon";
  const readinessRows = [
    {
      label: "Connection",
      value: status === "beta" ? "route live, data gated" : "not connected",
      tone: status === "beta" ? "caution" : "neutral",
    },
    {
      label: "Execution",
      value: "no write surface exposed",
      tone: "neutral",
    },
    {
      label: "Data",
      value: "missing renders as unavailable",
      tone: "info",
    },
  ];

  return (
    <main className={cn("ad-final ad-platform-readiness", className)} data-platform={platformId}>
      <header className="ad-platform-readiness-header">
        <div>
          <p className="ad-platform-kicker">Platform workspace</p>
          <h1>{title ?? `${platform.name} is coming`}</h1>
          <p>
            {description ??
              `Engine v3 onboarding is in early development. We will notify you when ${platform.name} joins the live platforms list.`}
          </p>
        </div>
        <div className="ad-platform-context-pill">
          <PlatformLogo platformId={platformId} size={16} />
          <span>{platform.name}</span>
          <strong data-status={status}>{badgeLabel}</strong>
        </div>
      </header>

      <section className="ad-platform-card">
        <div className="ad-platform-section-head">
          <div>
            <h2>{platform.name} readiness</h2>
            <p>This route is visible before execution is enabled so users see the honest product boundary.</p>
          </div>
          <a href="/integrations">Open Integrations →</a>
        </div>
        <div className="ad-platform-readiness-grid">
          {readinessRows.map((row) => (
            <div key={row.label} className="ad-platform-readiness-row" data-tone={row.tone}>
              <span aria-hidden="true" />
              <div>
                <p>{row.label}</p>
                <strong>{row.value}</strong>
              </div>
            </div>
          ))}
        </div>
        <div className="ad-platform-honesty-note">
          Blocked until backend readiness is explicit. Provider data is shown as unavailable, never as zero
          performance, and no automation or write control is exposed here.
        </div>
      </section>
    </main>
  );
}
