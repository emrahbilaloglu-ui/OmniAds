"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";

interface AuthIssueRow {
  businessId: string;
  businessName: string;
  provider: "meta" | "google" | "search_console" | "ga4" | "shopify";
  issueType: string;
  detail: string;
  tokenExpiresAt: string | null;
  updatedAt: string;
}

interface AuthHealthPayload {
  summary: {
    affectedBusinesses: number;
    connectedIntegrations: number;
    expiredTokens: number;
    expiringSoon: number;
    missingRefreshTokens: number;
    missingScopes: number;
    integrationErrors: number;
    topIssue: string | null;
  };
  issues: AuthIssueRow[];
}

function providerLabel(provider: AuthIssueRow["provider"]) {
  switch (provider) {
    case "google":
      return "Google Ads";
    case "search_console":
      return "Search Console";
    case "ga4":
      return "GA4";
    case "meta":
      return "Meta";
    default:
      return "Shopify";
  }
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("tr-TR");
}

const AUTH_HELP: Record<string, string> = {
  Affected:
    "At least one confirmed auth or OAuth failure is currently affecting this workspace.",
  Expired:
    "The stored access token is already expired, so provider requests will fail until the connection is refreshed or reconnected.",
  "Missing Scope":
    "The connection was created without one or more required provider permissions. The account may look connected, but some API calls cannot run.",
  "Integration Error":
    "The integration is already in an error state or the backend persisted a confirmed auth-related failure.",
  "Connected integrations":
    "Total currently connected integrations considered in this auth health view.",
  "Expired tokens":
    "Connections whose saved access token is no longer valid right now.",
};

function authIssueHelp(issueType: string) {
  if (issueType === "Missing required scope") {
    return "OAuth permission approval did not include a required provider scope, so some authenticated requests will be rejected.";
  }
  if (issueType === "Token expired") {
    return "The saved access token has already expired. Until it is refreshed or the user reconnects, provider calls will fail.";
  }
  if (issueType === "Integration error") {
    return "The integration has already entered a confirmed error state in the backend.";
  }
  return "This is a confirmed auth or OAuth problem that is already affecting provider access.";
}

export default function AdminAuthHealthPage() {
  const [payload, setPayload] = useState<AuthHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/auth-health")
      .then(async (response) => {
        const nextPayload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            (nextPayload as { message?: string } | null)?.message ??
              "Auth health could not be loaded."
          );
        }
        return nextPayload as AuthHealthPayload;
      })
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPayload(null);
        setLoadError(error instanceof Error ? error.message : "Auth health could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-400">Yükleniyor...</div>;
  }

  if (loadError) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">{loadError}</div>;
  }

  const summary = payload?.summary ?? {
    affectedBusinesses: 0,
    connectedIntegrations: 0,
    expiredTokens: 0,
    expiringSoon: 0,
    missingRefreshTokens: 0,
    missingScopes: 0,
    integrationErrors: 0,
    topIssue: null,
  };
  const issues = payload?.issues ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-50">
            <KeyRound className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Auth & OAuth Health</h1>
            <p className="text-sm text-gray-500 mt-1">Yalnızca gerçekten çalışmayı etkileyen auth/OAuth problemlerini gösterir</p>
          </div>
        </div>
        <Link href="/admin" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
          Dashboard&apos;a dön
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Affected" value={summary.affectedBusinesses} help={AUTH_HELP.Affected} />
        <MetricCard label="Expired" value={summary.expiredTokens} help={AUTH_HELP.Expired} />
        <MetricCard label="Missing Scope" value={summary.missingScopes} help={AUTH_HELP["Missing Scope"]} />
        <MetricCard label="Integration Error" value={summary.integrationErrors} help={AUTH_HELP["Integration Error"]} />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-900">Özet</p>
        <p className="text-sm text-gray-500 mt-2">
          {summary.connectedIntegrations} aktif bağlantı izleniyor. En yaygın problem:{" "}
          <span className="font-medium text-gray-700">{summary.topIssue ?? "Sorun yok"}</span>
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <InfoPill label="Connected integrations" value={summary.connectedIntegrations} help={AUTH_HELP["Connected integrations"]} />
          <InfoPill label="Expired tokens" value={summary.expiredTokens} help={AUTH_HELP["Expired tokens"]} />
          <InfoPill label="Missing scope" value={summary.missingScopes} help={AUTH_HELP["Missing Scope"]} />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Issue listesi</h2>
        </div>
        {issues.length === 0 ? (
          <div className="px-5 py-10 text-sm text-gray-400">Aktif auth veya OAuth problemi yok.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {issues.map((issue) => (
              <div key={`${issue.businessId}:${issue.provider}:${issue.issueType}:${issue.updatedAt}`} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{issue.businessName}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                      <span>{providerLabel(issue.provider)} • {issue.issueType}</span>
                      <InlineHelp text={authIssueHelp(issue.issueType)} />
                    </div>
                    <p className="text-sm text-gray-600 mt-3">{issue.detail}</p>
                  </div>
                  <div className="text-right text-xs text-gray-400">
                    <p>Token expiry: {formatDateTime(issue.tokenExpiresAt)}</p>
                    <p className="mt-1">Updated: {formatDateTime(issue.updatedAt)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  help,
}: {
  label: string;
  value: number;
  help?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
        {help ? <InlineHelp text={help} /> : null}
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-2">{value}</p>
    </div>
  );
}

function InfoPill({
  label,
  value,
  help,
}: {
  label: string;
  value: number;
  help?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
      <div className="flex items-center gap-1.5">
        <p className="text-[12px] uppercase tracking-wide text-gray-400">{label}</p>
        {help ? <InlineHelp text={help} /> : null}
      </div>
      <p className="text-lg font-semibold text-gray-900 mt-1">{value}</p>
    </div>
  );
}
