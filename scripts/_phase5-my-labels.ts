import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Row {
  [key: string]: string;
}

function parseCsv(text: string): Row[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur.length === 0) {
        inQ = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function int(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

interface Decision {
  label: "scale" | "keep" | "cut" | "refresh" | "test_more" | "diagnose";
  reason: string;
}

function decide(row: Row): Decision {
  const bucket = row.bucket;
  const targetRoas = num(row.target_roas) ?? (row.business === "TheSwaf" ? 2.2 : 3.5);
  const breakeven = num(row.break_even_roas) ?? targetRoas * 0.78;
  const aov = num(row.aov_assumption) ?? (row.business === "TheSwaf" ? 206 : 202);
  // expected CPA = AOV / target_roas; "mature" spend = 3× expected CPA per buyer rule
  const expectedCpa = aov / targetRoas;
  const matureSpendThreshold = expectedCpa * 3;

  const spend28 = num(row.spend_28d) ?? 0;
  const spendLife = num(row.spend_lifetime) ?? 0;
  const spend7 = num(row.spend_7d) ?? 0;
  const purchases28 = num(row.purchases_28d) ?? 0;
  const purchasesLife = num(row.purchases_lifetime) ?? 0;
  const roas28 = num(row.roas_28d);
  const roasLife = num(row.roas_lifetime);
  const roas7 = num(row.lc_roas_7d);
  const ctr28 = num(row.ctr_28d);
  const fatigue = row.fatigue_status;
  const lifecyclePos = row.lifecycle_position;
  const trajectory = row.spend_trajectory_30d;
  const fwk = row.funnel_primary_weak_stage;
  const trackingAnom = num(row.tracking_anomaly_score) ?? 0;
  const ageDays = int(row.age_days) ?? 0;
  const activeDays30 = int(row.active_days_30d) ?? 0;
  const daysSinceLastSpend = int(row.days_since_last_spend) ?? 0;

  const ratio28 = roas28 !== null && targetRoas > 0 ? roas28 / targetRoas : null;
  const ratio7 = roas7 !== null && targetRoas > 0 ? roas7 / targetRoas : null;
  const ratioLife = roasLife !== null && targetRoas > 0 ? roasLife / targetRoas : null;

  const money = (n: number) => `$${n.toFixed(0)}`;
  const x = (n: number) => `${n.toFixed(2)}×`;

  // 1) DIAGNOSE: tracking anomaly OR mature spend with no purchases despite clicks
  if (trackingAnom >= 0.7) {
    return {
      label: "diagnose",
      reason: `Tracking anomaly score ${trackingAnom.toFixed(2)} — sayım/attribution güvenilir değil, karar öncesi pixel + commercial truth kontrol şart.`,
    };
  }
  if (spend28 >= matureSpendThreshold && purchases28 === 0 && ctr28 !== null && ctr28 > 0.005) {
    return {
      label: "diagnose",
      reason: `${money(spend28)} 28g harcama + ${ctr28 ? (ctr28 * 100).toFixed(2) : "?"}% CTR ama 0 sipariş — clicks geliyor ama dönüş yok. Tracking veya site/checkout sorunu, kreatifi tek başına suçlama.`,
    };
  }
  if (fwk === "checkout" || fwk === "tracking") {
    const cresp = num(row.creative_responsibility_score) ?? 0.5;
    if (cresp < 0.4 && spend28 >= matureSpendThreshold * 0.5) {
      return {
        label: "diagnose",
        reason: `Funnel weak stage = ${fwk}, creative_responsibility ${cresp.toFixed(2)} (düşük) — kreatif değil site/checkout sorunu, ${money(spend28)}'da kapatma kararı kreatif düzeltmez.`,
      };
    }
  }
  // status/spend mismatch
  if (
    bucket === "active" &&
    row.effective_status?.toUpperCase().includes("ACTIVE") &&
    spend7 < 1 &&
    daysSinceLastSpend > 7
  ) {
    return {
      label: "diagnose",
      reason: `Status ACTIVE ama son ${daysSinceLastSpend}g harcama yok — delivery sorunu, policy reject veya budget zero. Pause/resume manuel kontrol gerekiyor.`,
    };
  }

  // CLOSED_30D retroactive
  if (bucket === "closed_30d") {
    // Mature loser correctly closed
    if (spendLife >= matureSpendThreshold && ratioLife !== null && ratioLife < 0.6) {
      return {
        label: "cut",
        reason: `Closed: ${money(spendLife)} lifetime + ROAS ${roasLife?.toFixed(2)} (${x(ratioLife)} target) — olgun kayıp, doğru kapatma.`,
      };
    }
    // Closed with no/low purchases + 3x CPA spend = correct cut
    if (spendLife >= matureSpendThreshold && purchasesLife <= 1) {
      return {
        label: "cut",
        reason: `Closed: ${money(spendLife)} harcama + ${purchasesLife} sipariş — 3×CPA ($${matureSpendThreshold.toFixed(0)}) eşiği aşıldı sipariş yok, doğru cut.`,
      };
    }
    // Closed too early (low spend)
    if (spendLife < matureSpendThreshold * 0.5) {
      return {
        label: "test_more",
        reason: `Closed: sadece ${money(spendLife)} test edildi (3×CPA eşiği $${matureSpendThreshold.toFixed(0)}) — olgunlaşmadan kapatıldı, daha test edilmeliydi.`,
      };
    }
    // Closed despite strong performance
    if (ratioLife !== null && ratioLife >= 1.0 && purchasesLife >= 5) {
      return {
        label: "diagnose",
        reason: `Closed: ROAS ${roasLife?.toFixed(2)} (${x(ratioLife)} target) + ${purchasesLife} sipariş — kapatma sebebi veriden anlaşılmıyor, manuel review.`,
      };
    }
    // Borderline closed — past peak (any flavor) or fatigue
    if (
      lifecyclePos === "past_peak_natural" ||
      lifecyclePos === "past_peak_inaction" ||
      lifecyclePos === "past_peak_unclear" ||
      fatigue === "fatigued" ||
      fatigue === "watch"
    ) {
      // Only refresh if lifetime perf was at least decent
      if (ratioLife !== null && ratioLife >= 0.7) {
        return {
          label: "refresh",
          reason: `Closed past peak (${lifecyclePos}${fatigue !== "none" ? `, fatigue=${fatigue}` : ""}), ${money(spendLife)} lifetime ROAS ${roasLife?.toFixed(2) ?? "?"} (${ratioLife.toFixed(2)}× target) — concept iyiydi, fresh angle ile yeniden test.`,
        };
      }
    }
    // Default closed — mid spend, decent perf, retro-keep equivalent (use cut as retroactive close was within reason)
    if (ratioLife !== null && ratioLife >= 0.85 && ratioLife < 1.0) {
      return {
        label: "diagnose",
        reason: `Closed: ROAS ${roasLife?.toFixed(2)} (${x(ratioLife)} hedefin altında ama yakın), ${money(spendLife)} — kapanma kararı tartışmalı, daha çok süre verilebilirdi.`,
      };
    }
    // remaining: spend > threshold but ROAS unclear/low
    return {
      label: "cut",
      reason: `Closed: ${money(spendLife)} + ROAS ${roasLife?.toFixed(2) ?? "?"} (${ratioLife !== null ? x(ratioLife) : "?"} target) — olgun ve hedef altı, retro-cut onaylı.`,
    };
  }

  // ACTIVE bucket judgments

  // Test more: not enough data
  if (spend28 < matureSpendThreshold * 0.4) {
    return {
      label: "test_more",
      reason: `${money(spend28)} 28g harcama (3×CPA eşiği $${matureSpendThreshold.toFixed(0)}'ın altında) — sample henüz yeterli değil, devam ettir izle.`,
    };
  }
  if (purchases28 < 3) {
    return {
      label: "test_more",
      reason: `${money(spend28)} 28g + ${purchases28} sipariş — purchase sample çok küçük, sinyal güvenilmez.`,
    };
  }
  if (activeDays30 < 5 && ageDays < 14) {
    return {
      label: "test_more",
      reason: `Sadece ${activeDays30}g aktif ${ageDays}g yaşında — yeni kreatif, learning'den çıkmadan karar vermem.`,
    };
  }

  // Cut candidates: mature + clearly losing
  if (spend28 >= matureSpendThreshold * 1.5 && ratio28 !== null && ratio28 < 0.6) {
    // Recent recovery check
    if (ratio7 !== null && ratio7 >= 0.85) {
      return {
        label: "keep",
        reason: `28g zayıf (${roas28?.toFixed(2)} = ${x(ratio28)}) ama 7g toparlanma (${roas7?.toFixed(2)} = ${x(ratio7)}) — recent strength, izlemeye devam.`,
      };
    }
    return {
      label: "cut",
      reason: `${money(spend28)} 28g (≥1.5× mature) + ROAS ${roas28?.toFixed(2)} (${x(ratio28)} target) + 7g toparlanma yok — olgun kayıp, kes.`,
    };
  }
  // Mature + 0-1 purchases despite hefty spend
  if (spend28 >= matureSpendThreshold * 2 && purchases28 <= 1) {
    return {
      label: "cut",
      reason: `${money(spend28)} (2× mature) + ${purchases28} sipariş — boşa harcanıyor, kes.`,
    };
  }

  // Scale candidates: clearly winning + mature
  // Recent 7d check: only apply if recent spend is large enough to be informative (≥0.4× expected CPA = ~1 purchase worth of spend)
  const lcSpend7 = num(row.lc_spend_7d) ?? 0;
  const recentInformative = lcSpend7 >= expectedCpa * 0.4;
  const recentConfirms = !recentInformative || ratio7 === null || ratio7 >= 0.7;
  if (
    spend28 >= matureSpendThreshold &&
    purchases28 >= 6 &&
    ratio28 !== null &&
    ratio28 >= 1.3 &&
    fatigue !== "fatigued" &&
    recentConfirms
  ) {
    const recentNote = recentInformative
      ? ` + 7g ${roas7?.toFixed(2)} (${ratio7 !== null ? x(ratio7) : "?"})`
      : ` (7g spend ${money(lcSpend7)} az, ROAS ${roas7?.toFixed(2) ?? "?"} bilgi vermez)`;
    return {
      label: "scale",
      reason: `${money(spend28)} olgun + ${purchases28} sipariş + 28g ROAS ${roas28?.toFixed(2)} (${x(ratio28)} target)${recentNote}, fatigue=${fatigue} — winner, scale.`,
    };
  }

  // Near-scale but recent week broken: keep + observe (don't fallback to test_more)
  if (
    spend28 >= matureSpendThreshold &&
    purchases28 >= 5 &&
    ratio28 !== null &&
    ratio28 >= 1.3 &&
    fatigue !== "fatigued"
  ) {
    return {
      label: "keep",
      reason: `28g winner: ${money(spend28)} + ${purchases28} sipariş + ROAS ${roas28?.toFixed(2)} (${x(ratio28)} target), ama 7g zayıflık (spend ${money(lcSpend7)} ROAS ${roas7?.toFixed(2) ?? "?"}) — scale öncesi bir hafta daha izle.`,
    };
  }

  // Refresh: long-term decent but recent weakening + fatigue
  if (
    fatigue === "fatigued" ||
    (fatigue === "watch" && (lifecyclePos === "past_peak_inaction" || lifecyclePos === "past_peak_unclear" || trajectory === "falling"))
  ) {
    if (ratioLife !== null && ratioLife >= 0.7) {
      return {
        label: "refresh",
        reason: `Lifetime ROAS ${roasLife?.toFixed(2)} (${x(ratioLife)} target) iyiydi, şimdi fatigue=${fatigue}${lifecyclePos ? ` lifecycle=${lifecyclePos}` : ""} — concept good, fresh angle ile yenile.`,
      };
    }
  }
  // Past peak inaction — operator hasn't acted on a winner that's tiring
  if (lifecyclePos === "past_peak_inaction" && ratio28 !== null && ratio28 >= 0.85) {
    return {
      label: "refresh",
      reason: `Past peak inaction, ROAS ${roas28?.toFixed(2)} (${x(ratio28)} hâlâ hedefe yakın) — peak'ten beri ${row.days_since_peak ?? "?"}g, operator karar vermemiş, refresh time.`,
    };
  }

  // Keep: mature + stable around target
  if (ratio28 !== null && ratio28 >= 0.75 && ratio28 < 1.3) {
    return {
      label: "keep",
      reason: `${money(spend28)} olgun + ROAS ${roas28?.toFixed(2)} (${x(ratio28)} target) — hedef civarı stabil, dramatik tetik yok.`,
    };
  }

  // Borderline: mature with weak signal, no recovery, but not catastrophic
  if (ratio28 !== null && ratio28 < 0.75) {
    return {
      label: "cut",
      reason: `${money(spend28)} olgun + ROAS ${roas28?.toFixed(2)} (${x(ratio28)} target hedefin altında) + recovery yok — kes, daha agresif placement'lara para git.`,
    };
  }

  // Fallback
  return {
    label: "test_more",
    reason: `Karar için sinyal net değil — devam ettir, daha çok veri gelsin.`,
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const baseDir = resolve(process.cwd(), "_analysis/phase-5");
  const raw = readFileSync(resolve(baseDir, "01-raw.csv"), "utf8");
  const rows = parseCsv(raw);

  console.log(`[my-labels] processing ${rows.length} rows...`);

  const out = ["creative_id,business,creative_name,bucket,my_label,my_reason"];
  const dist: Record<string, number> = {};

  for (const row of rows) {
    const dec = decide(row);
    dist[dec.label] = (dist[dec.label] ?? 0) + 1;
    out.push([
      row.creative_id,
      row.business,
      row.creative_name,
      row.bucket,
      dec.label,
      dec.reason,
    ].map(csvCell).join(","));
  }

  writeFileSync(resolve(baseDir, "03-my-labels.csv"), out.join("\n") + "\n");
  console.log(`\n[my-labels] distribution:`);
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\n[my-labels] wrote ${baseDir}/03-my-labels.csv`);
}

main();
