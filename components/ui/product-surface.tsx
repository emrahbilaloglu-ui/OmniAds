import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SurfaceTone = "neutral" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<SurfaceTone, string> = {
  neutral: "ad-product-tone-neutral",
  info: "ad-product-tone-info",
  success: "ad-product-tone-success",
  warning: "ad-product-tone-warning",
  danger: "ad-product-tone-danger",
};

export function ProductPageShell({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ad-product-page", className)}>
      <header className="ad-product-header">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="ad-product-eyebrow">{eyebrow}</p>
          ) : null}
          <h1 className="ad-product-title">{title}</h1>
          {description ? <p className="ad-product-description">{description}</p> : null}
        </div>
        {actions ? <div className="ad-product-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function ProductSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("ad-product-section", className)}>
      {title || description || actions ? (
        <div className="ad-product-section-header">
          <div className="min-w-0">
            {title ? <h2 className="ad-product-section-title">{title}</h2> : null}
            {description ? <p className="ad-product-section-description">{description}</p> : null}
          </div>
          {actions ? <div className="ad-product-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="ad-product-section-body">{children}</div>
    </section>
  );
}

export function CompactMetricTile({
  label,
  value,
  detail,
  tone = "neutral",
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: SurfaceTone;
  className?: string;
}) {
  return (
    <div className={cn("ad-product-metric", toneClasses[tone], className)}>
      <div className="ad-product-metric-label">{label}</div>
      <div className="ad-product-metric-value">{value}</div>
      {detail ? <div className="ad-product-metric-detail">{detail}</div> : null}
    </div>
  );
}

export function StateBanner({
  tone = "neutral",
  title,
  children,
  className,
}: {
  tone?: SurfaceTone;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ad-product-banner", toneClasses[tone], className)}>
      <div className="ad-product-banner-title">{title}</div>
      {children ? <div className="ad-product-banner-body">{children}</div> : null}
    </div>
  );
}

export function MobileReadOnlyCard({
  label,
  value,
  meta,
  action,
  tone = "neutral",
  children,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  tone?: SurfaceTone;
  children?: ReactNode;
}) {
  return (
    <article className={cn("ad-mobile-card md:hidden", toneClasses[tone])}>
      <div className="ad-mobile-card-top">
        <div>
          <div className="ad-mobile-card-label">{label}</div>
          <div className="ad-mobile-card-value">{value}</div>
        </div>
        {meta ? <div className="ad-mobile-card-meta">{meta}</div> : null}
      </div>
      {children ? <div className="ad-mobile-card-body">{children}</div> : null}
      {action ? <div className="ad-mobile-card-action">{action}</div> : null}
    </article>
  );
}
