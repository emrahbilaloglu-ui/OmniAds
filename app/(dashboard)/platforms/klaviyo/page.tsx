"use client";

import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";

const TH =
  "bg-[var(--adv-fill)] px-4 py-[9px] text-left font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--adv-ink-3)]";

export default function KlaviyoPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  useBusinessIntegrationsBootstrap(selectedBusinessId ?? null);

  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined,
  );
  const view = deriveProviderViewState(
    "klaviyo",
    domains?.klaviyo ?? buildDefaultProviderDomains().klaviyo,
  );

  /**
   * Klaviyo has an OAuth start route but no reporting endpoint yet, so there is
   * no served flow data for any connection state. The table keeps the design's
   * shape and says which of the two blockers applies rather than seeding rows.
   */
  const emptyCopy = view.isConnected
    ? "Klaviyo is connected, but flow reporting is not served yet — no endpoint returns flow revenue, open rate or recipients."
    : "Connect Klaviyo from Integrations to begin importing lifecycle flows.";

  return (
    <div className="ad-workspace-page">
      <div className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
              Klaviyo · Email &amp; SMS
            </p>
            <h1 className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--adv-ink)]">
              Lifecycle
            </h1>
          </div>
          <span className="inline-flex shrink-0 rounded-full bg-[#FBF3E1] px-3 py-1 text-[12px] font-bold text-[#B45309]">
            BETA — read-only analysis
          </span>
        </div>

        <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={TH}>Flow</th>
                  <th className={TH.replace("px-4", "px-3")}>Status</th>
                  <th className={`${TH.replace("px-4", "px-3")} text-right`}>Revenue · 28d</th>
                  <th className={`${TH.replace("px-4", "px-3")} text-right`}>Open rate</th>
                  <th className={`${TH} text-right`}>Recipients</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-[12.5px] text-[var(--adv-ink-3)]">
                    {emptyCopy}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <p className="m-0 text-[11px] text-[var(--adv-ink-4)]">
          The Overview opportunity &quot;win-back flow for 60-day lapsed buyers&quot; starts here —
          the draft is pre-scoped to that segment.
        </p>
      </div>
    </div>
  );
}
