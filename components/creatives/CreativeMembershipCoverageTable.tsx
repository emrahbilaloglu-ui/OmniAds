import type { CreativeMembershipCoverage } from "@/lib/meta/creative-membership-coverage";

export function CreativeMembershipCoverageTable(input: {
  coverage?: CreativeMembershipCoverage;
  businessId: string; providerAccountId: string | null; startDate: string; endDate: string;
}) {
  const c = input.coverage;
  if (!c || c.businessId !== input.businessId || c.providerAccountId !== input.providerAccountId ||
    c.startDate !== input.startDate || c.endDate !== input.endDate) return null;
  const metric = (n: number | null) => n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return <details className="mt-4 rounded-xl border p-4" data-creative-membership-coverage>
    <summary>Daily source coverage · {c.startDate} – {c.endDate}</summary>
    <p>These source rows precede format filters. Verified rows contribute to creative totals; provisional rows remain pending. Withheld rows have unverified creative membership, so their amounts cannot yet be assigned to verified creative totals. An em dash means no measured total, not zero.</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr><th>Date / currency</th><th>Verified rows · spend / purchases</th><th>Provisional rows · spend / purchases</th><th>Withheld rows · spend / purchases</th></tr></thead>
      <tbody>{c.days.map((day) => <tr key={`${day.date}:${day.currency}`}>
        <th>{day.date} / {day.currency ?? "currency unknown"}</th>
        <td>{day.verifiedRows} · {metric(day.verifiedSpend)} / {metric(day.verifiedPurchases)}</td>
        <td>{day.provisionalRows} · {metric(day.provisionalSpend)} / {metric(day.provisionalPurchases)}</td>
        <td>{day.withheldRows} · {metric(day.withheldSpend)} / {metric(day.withheldPurchases)}</td>
      </tr>)}</tbody>
    </table></div>
    <p>Owner: data integration. Reconcile dated provider Ad rows and creative membership before restoring withheld totals; current creative mapping alone is insufficient.</p>
  </details>;
}
