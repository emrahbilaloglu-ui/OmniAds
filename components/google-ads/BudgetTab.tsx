"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, fmtPercent, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";
import { usePreferencesStore } from "@/store/preferences-store";

interface BudgetCampaign {
  id: string;
  name: string;
  dailyBudget: number;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  impressions: number;
  clicks: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
  lostIsRank?: number | null;
}

interface BudgetRec {
  campaign: string;
  currentSpend: number;
  suggestedBudgetChange: number;
  direction: "increase" | "decrease";
  reason: string;
}

function getCols(language: "en" | "tr"): ColDef<BudgetCampaign>[] {
  return [
  { key: "name", header: language === "tr" ? "Kampanya" : "Campaign", accessor: (r) => r.name, render: (r) => <span className="text-xs font-medium truncate block max-w-[160px]">{r.name}</span> },
  { key: "dailyBudget", header: language === "tr" ? "Gunluk Butce" : "Daily Budget", accessor: (r) => r.dailyBudget, align: "right", render: (r) => r.dailyBudget > 0 ? fmtCurrency(r.dailyBudget) : "—" },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold" : r.roas < 1 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  {
    key: "impressionShare", header: "IS", accessor: (r) => r.impressionShare ?? 0, align: "right",
    render: (r) => r.impressionShare != null ? fmtPercent(r.impressionShare * 100) : "—",
  },
  {
    key: "lostIsBudget", header: language === "tr" ? "Kayip IS (Butce)" : "Lost IS (Budget)", accessor: (r) => r.lostIsBudget ?? 0, align: "right",
    render: (r) =>
      r.lostIsBudget != null && r.lostIsBudget > 0
        ? <span className="text-[var(--adc-caution-fg)] dark:text-[var(--adc-caution-fg)] font-semibold">{fmtPercent(r.lostIsBudget * 100)}</span>
        : "—",
  },
  {
    key: "lostIsRank",
    header: language === "tr" ? "Kayip IS (Rank)" : "Lost IS (Rank)",
    accessor: (r) => r.lostIsRank ?? 0,
    align: "right",
    render: (r) =>
      r.lostIsRank != null && r.lostIsRank > 0
        ? <span className="text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)] font-semibold">{fmtPercent(r.lostIsRank * 100)}</span>
        : "—",
  },
];
}

interface BudgetTabProps {
  campaigns?: BudgetCampaign[];
  recommendations?: BudgetRec[];
  totalSpend?: number;
  accountAvgRoas?: number;
  isLoading: boolean;
}

export function BudgetTab({ campaigns, recommendations, totalSpend, accountAvgRoas, isLoading }: BudgetTabProps) {
  const language = usePreferencesStore((state) => state.language);
  const cols = getCols(language);
  if (isLoading) return <TabSkeleton />;
  if (!campaigns || campaigns.length === 0) {
    return <TabEmpty message={language === "tr" ? "Bu dönem için bütçe verisi bulunamadi." : "No budget data found for this period."} />;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {language === "tr"
          ? "Butce dağılımi ve impression share sinyalleri. Butce nedeniyle anlamli IS kaybeden kampanyalar kısıtli kaliyor; düşük ROAS kampanyalardan yeniden dağılım dusunun."
          : "Budget distribution and impression share signals. Campaigns losing significant IS to budget are constrained — consider reallocation from low-ROAS campaigns."}
      </p>

      {/* Budget recommendations */}
      {recommendations && recommendations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{language === "tr" ? "Butce Önerileri" : "Budget Recommendations"}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {recommendations.slice(0, 4).map((rec, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-xl border p-4",
                  rec.direction === "increase"
                    ? "border-[var(--adc-pos-bd)] dark:border-[var(--adc-pos-bd)]/50 bg-[var(--adc-pos-bg)] dark:bg-[var(--adc-pos-fg)]/30"
                    : "border-[var(--adc-danger-bd)] dark:border-[var(--adc-danger-bd)]/50 bg-[var(--adc-danger-bg)] dark:bg-[var(--adc-danger-fg)]/30"
                )}
              >
                <p className="text-xs font-semibold truncate" title={rec.campaign}>{rec.campaign}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{rec.reason}</p>
                <p className={cn("text-sm font-bold mt-2", rec.direction === "increase" ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]" : "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]")}>
                  {rec.direction === "increase" ? "+" : "-"}{fmtCurrency(Math.abs(rec.suggestedBudgetChange))}
                  <span className="text-xs font-normal text-muted-foreground ml-1">{language === "tr" ? "önerilen kaydırma" : "suggested shift"}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <SimpleTable cols={cols} rows={campaigns} defaultSort="spend" />
    </div>
  );
}
