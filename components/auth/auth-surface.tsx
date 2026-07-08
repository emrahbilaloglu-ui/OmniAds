import type { ReactNode } from "react";

export function AuthSurface({
  eyebrow,
  title,
  description,
  children,
  footer,
  width = "sm",
  embedded = false,
  titleOnBrandLine = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  embedded?: boolean;
  titleOnBrandLine?: boolean;
}) {
  return (
    <main className={`ad-auth-page${embedded ? " ad-auth-page-embedded" : ""}`}>
      <section className={`ad-auth-card ad-auth-card-${width}`}>
        {eyebrow ? <div className="ad-auth-eyebrow">{eyebrow}</div> : null}
        <div className="ad-auth-brand">
          <span className="ad-auth-mark" aria-hidden="true" />
          {titleOnBrandLine ? <h1>{title}</h1> : <span>Adsecute</span>}
        </div>
        {titleOnBrandLine ? (
          description ? (
            <div className="ad-auth-heading">
              <p>{description}</p>
            </div>
          ) : null
        ) : (
          <div className="ad-auth-heading">
            <h1>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
        )}
        {children}
        {footer ? <div className="ad-auth-footer">{footer}</div> : null}
      </section>
    </main>
  );
}
