"use client";

import { usePathname } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

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
        title="Account"
        scope={null}
        railFooter={
          <p style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
            {envelope.actor.name} · {businessCount} business{businessCount === 1 ? "" : "es"}
          </p>
        }
        topBarActions={
          <UserMenu
            name={envelope.actor.name}
            onLogout={() => {
              window.location.href = "/logout";
            }}
          />
        }
      >
        {children}
      </AppShell>
    </WorkspaceContextProvider>
  );
}
