import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type WorkspaceTone = "neutral" | "positive" | "warning" | "danger" | "info" | "auto";

const toneClass: Record<WorkspaceTone, string> = {
  neutral: "ad-workspace-tone-neutral",
  positive: "ad-workspace-tone-positive",
  warning: "ad-workspace-tone-warning",
  danger: "ad-workspace-tone-danger",
  info: "ad-workspace-tone-info",
  auto: "ad-workspace-tone-auto",
};

export function WorkspaceSurface({
  title,
  description,
  eyebrow = "Workspace",
  meta,
  actions,
  children,
  width = "default",
  className,
}: {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "narrow" | "wide";
  className?: string;
}) {
  return (
    <div className={cn("ad-workspace-page", `ad-workspace-page-${width}`, className)}>
      <header className="ad-workspace-header">
        <div className="min-w-0">
          <div className="ad-workspace-eyebrow">{eyebrow}</div>
          <div className="ad-workspace-title-row">
            <h1>{title}</h1>
            {meta ? <div className="ad-workspace-header-meta">{meta}</div> : null}
          </div>
          {description ? <p className="ad-workspace-description">{description}</p> : null}
        </div>
        {actions ? <div className="ad-workspace-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function WorkspaceCard({
  title,
  description,
  actions,
  children,
  tone = "neutral",
  className,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: WorkspaceTone;
  className?: string;
}) {
  return (
    <section className={cn("ad-workspace-card", toneClass[tone], className)}>
      {title || description || actions ? (
        <div className="ad-workspace-card-header">
          <div className="min-w-0">
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="ad-workspace-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className="ad-workspace-card-body">{children}</div> : null}
    </section>
  );
}

export function WorkspaceStat({
  label,
  value,
  detail,
  tone = "neutral",
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: WorkspaceTone;
  className?: string;
}) {
  return (
    <div className={cn("ad-workspace-stat", toneClass[tone], className)}>
      <div className="ad-workspace-stat-label">{label}</div>
      <div className="ad-workspace-stat-value">{value}</div>
      {detail ? <div className="ad-workspace-stat-detail">{detail}</div> : null}
    </div>
  );
}

export function WorkspacePill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: WorkspaceTone;
  className?: string;
}) {
  return <span className={cn("ad-workspace-pill", toneClass[tone], className)}>{children}</span>;
}

export function WorkspaceMono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ad-workspace-mono", className)}>{children}</span>;
}

export function WorkspaceAnchorNav({
  items,
  className,
}: {
  items: Array<{ id: string; label: string }>;
  className?: string;
}) {
  return (
    <nav aria-label="Workspace sections" className={cn("ad-workspace-anchor-nav", className)}>
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
