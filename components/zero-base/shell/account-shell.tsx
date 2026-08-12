"use client";

import { usePathname } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

/**
 * Account chrome. No context bar and no client nav: these leaves belong to the
 * person, not to a business, and showing a client scope here would imply the
 * settings are scoped to it.
 */
export function AccountShell({
  envelope,
  businessCount,
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  businessCount: number;
  children: React.ReactNode;
}) {
  const copy = useCopy();
  const pathname = usePathname() ?? "";
  const groups = [
    {
      id: "me",
      label: "Account",
      items: [
        {
          leaf: "L-ME-ACCOUNT" as const,
          label: "Account & security",
          url: "/me/account-security",
          role: "Any authenticated",
        },
        {
          leaf: "L-ME-LANG" as const,
          label: "Language",
          url: "/me/language",
          role: "Any authenticated",
        },
      ],
    },
  ];

  return (
    <WorkspaceContextProvider value={envelope}>
      <AppShell
        groups={groups}
        businessId={null}
        pathname={pathname}
        title={copy.account}
        scope={null}
        railFooter={
          <div style={{ display: "grid", gap: 6 }}>
            <UserMenu
              name={envelope.actor.name}
              rail
              onLogout={() => {
                window.location.href = "/logout";
              }}
            />
            <p style={{ margin: 0, paddingInline: 8, fontSize: 12, lineHeight: "17px", color: "var(--ledger-ink-tertiary)" }}>
              {businessCount} business{businessCount === 1 ? "" : "es"}
            </p>
          </div>
        }
      >
        {children}
      </AppShell>
    </WorkspaceContextProvider>
  );
}
