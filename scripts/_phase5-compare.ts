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
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur.length === 0) inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const baseDir = resolve(process.cwd(), "_analysis/phase-5");

interface Joined {
  business: string;
  creative_id: string;
  creative_name: string;
  bucket: string;
  spend_lifetime: number;
  spend_28d: number;
  purchases_28d: number;
  roas_28d: string;
  target_roas: string;
  v3: string;
  me: string;
  marcus: string;
  lin: string;
  aria: string;
  me_reason: string;
  v3_reason: string;
  agreement_count: number;
  unique_labels: number;
  consensus_label: string;
}

const LABELS = ["scale", "keep", "refresh", "cut", "test_more", "diagnose"];

function loadLabels(file: string, key: string): Map<string, { label: string; reason: string }> {
  const rows = parseCsv(readFileSync(resolve(baseDir, file), "utf8"));
  const m = new Map<string, { label: string; reason: string }>();
  for (const r of rows) {
    m.set(r.creative_id, { label: r.my_label || r[key] || "", reason: r.my_reason || r.reason || "" });
  }
  return m;
}

function loadV3(): Map<string, { label: string; reason: string }> {
  const rows = parseCsv(readFileSync(resolve(baseDir, "02-v3-decisions.csv"), "utf8"));
  const m = new Map<string, { label: string; reason: string }>();
  for (const r of rows) {
    m.set(r.creative_id, { label: r.v3_label || "", reason: r.v3_reason || "" });
  }
  return m;
}

function loadRaw(): Map<string, Row> {
  const rows = parseCsv(readFileSync(resolve(baseDir, "01-raw.csv"), "utf8"));
  const m = new Map<string, Row>();
  for (const r of rows) m.set(r.creative_id, r);
  return m;
}

function consensusOf(labels: string[]): { label: string; count: number } {
  const tally: Record<string, number> = {};
  for (const l of labels) {
    if (!l) continue;
    tally[l] = (tally[l] ?? 0) + 1;
  }
  let best = "no_consensus";
  let bestN = 0;
  for (const [k, v] of Object.entries(tally)) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  // Require strict majority of NON-NULL labels
  const total = labels.filter((l) => l).length;
  if (bestN < Math.ceil(total / 2)) return { label: "no_consensus", count: bestN };
  return { label: best, count: bestN };
}

async function main() {
  const raw = loadRaw();
  const v3 = loadV3();
  const me = loadLabels("03-my-labels.csv", "my_label");
  const marcus = loadLabels("04-marcus.csv", "my_label");
  const lin = loadLabels("04-lin.csv", "my_label");
  const aria = loadLabels("04-aria.csv", "my_label");

  const joined: Joined[] = [];
  for (const [creative_id, r] of raw) {
    const v3l = v3.get(creative_id)?.label || "missing";
    const v3r = v3.get(creative_id)?.reason || "";
    const mel = me.get(creative_id)?.label || "missing";
    const mer = me.get(creative_id)?.reason || "";
    const ml = marcus.get(creative_id)?.label || "missing";
    const ll = lin.get(creative_id)?.label || "missing";
    const al = aria.get(creative_id)?.label || "missing";

    const labels = [v3l, mel, ml, ll, al].filter((x) => x !== "missing" && x !== "out_of_scope");
    const uniqueLabels = new Set(labels).size;
    const cons = consensusOf(labels);

    joined.push({
      business: r.business,
      creative_id,
      creative_name: r.creative_name,
      bucket: r.bucket,
      spend_lifetime: parseFloat(r.spend_lifetime ?? "0") || 0,
      spend_28d: parseFloat(r.spend_28d ?? "0") || 0,
      purchases_28d: parseFloat(r.purchases_28d ?? "0") || 0,
      roas_28d: r.roas_28d ?? "",
      target_roas: r.target_roas ?? "",
      v3: v3l,
      me: mel,
      marcus: ml,
      lin: ll,
      aria: al,
      me_reason: mer,
      v3_reason: v3r,
      agreement_count: cons.count,
      unique_labels: uniqueLabels,
      consensus_label: cons.label,
    });
  }

  joined.sort((a, b) => b.spend_lifetime - a.spend_lifetime);

  const csvHeader = [
    "business", "creative_id", "creative_name", "bucket",
    "spend_lifetime", "spend_28d", "purchases_28d", "roas_28d", "target_roas",
    "v3", "me", "marcus", "lin", "aria",
    "agreement_count", "unique_labels", "consensus_label",
    "v3_reason", "me_reason",
  ];
  const csvLines = [csvHeader.join(",")];
  for (const j of joined) {
    csvLines.push(csvHeader.map((c) => {
      const v = (j as unknown as Record<string, unknown>)[c];
      if (typeof v === "number") return csvCell(v.toFixed(2));
      return csvCell(v);
    }).join(","));
  }
  writeFileSync(resolve(baseDir, "05-comparison.csv"), csvLines.join("\n") + "\n");

  // Stats
  const total = joined.length;

  // Distribution per labeler
  const dist: Record<string, Record<string, number>> = {
    v3: {}, me: {}, marcus: {}, lin: {}, aria: {},
  };
  for (const j of joined) {
    for (const k of ["v3", "me", "marcus", "lin", "aria"] as const) {
      const v = j[k];
      dist[k][v] = (dist[k][v] ?? 0) + 1;
    }
  }

  // Pairwise agreement
  const labelers = ["v3", "me", "marcus", "lin", "aria"] as const;
  const pairwise: Record<string, Record<string, number>> = {};
  for (const a of labelers) {
    pairwise[a] = {};
    for (const b of labelers) {
      let agree = 0;
      let comparable = 0;
      for (const j of joined) {
        if (j[a] === "missing" || j[b] === "missing") continue;
        if (j[a] === "out_of_scope" || j[b] === "out_of_scope") continue;
        comparable++;
        if (j[a] === j[b]) agree++;
      }
      pairwise[a][b] = comparable > 0 ? agree / comparable : 0;
    }
  }

  // Strong consensus (all 5 same)
  const strong: Joined[] = joined.filter((j) => j.unique_labels === 1);
  const consensus4: Joined[] = joined.filter((j) => j.unique_labels === 1 || (j.unique_labels === 2 && j.agreement_count >= 4));
  const high_disagree: Joined[] = joined.filter((j) => j.unique_labels >= 4);

  // Build markdown
  const md: string[] = [];
  md.push("# Phase 5 — 5-way comparison: v3 / me / Marcus / Dr. Lin / Aria");
  md.push("");
  md.push(`Universe: **${total} creatives** (TheSwaf 47 + IwaStore 107; active + closed_30d).`);
  md.push("");
  md.push("## Distribution per labeler");
  md.push("");
  md.push(`| Label | v3 | me | Marcus | Dr. Lin | Aria |`);
  md.push(`|---|---:|---:|---:|---:|---:|`);
  const allLabels = ["scale", "keep", "refresh", "cut", "test_more", "diagnose", "out_of_scope", "missing"];
  for (const l of allLabels) {
    const row = [l];
    for (const k of ["v3", "me", "marcus", "lin", "aria"] as const) {
      row.push(String(dist[k][l] ?? 0));
    }
    md.push(`| ${row.join(" | ")} |`);
  }
  md.push("");
  md.push("## Pairwise agreement (excluding missing/out_of_scope)");
  md.push("");
  md.push(`| | ${labelers.join(" | ")} |`);
  md.push(`|---|${labelers.map(() => "---:").join("|")}|`);
  for (const a of labelers) {
    const row = [a];
    for (const b of labelers) {
      row.push(`${(pairwise[a][b] * 100).toFixed(1)}%`);
    }
    md.push(`| ${row.join(" | ")} |`);
  }
  md.push("");
  md.push(`## Strong consensus (5/5 same label) — ${strong.length} creatives`);
  md.push("");
  if (strong.length > 0) {
    md.push(`| business | creative_id | name | bucket | spend_28d | roas_28d | label |`);
    md.push(`|---|---|---|---|---:|---:|---|`);
    for (const j of strong.slice(0, 30)) {
      md.push(`| ${j.business} | ${j.creative_id} | ${(j.creative_name ?? "").slice(0, 30)} | ${j.bucket} | $${j.spend_28d.toFixed(0)} | ${j.roas_28d || "—"} | ${j.consensus_label} |`);
    }
    if (strong.length > 30) md.push(`\n_... and ${strong.length - 30} more_`);
  }
  md.push("");
  md.push(`## 4/5 consensus (1 outlier) — ${consensus4.length - strong.length} creatives`);
  md.push("");
  const fourFive = joined.filter((j) => j.unique_labels === 2 && j.agreement_count === 4);
  if (fourFive.length > 0) {
    md.push(`| business | name | bucket | spend_28d | roas_28d | v3 | me | Marcus | Lin | Aria | outlier |`);
    md.push(`|---|---|---|---:|---:|---|---|---|---|---|---|`);
    for (const j of fourFive.slice(0, 25)) {
      // find outlier
      const labels = { v3: j.v3, me: j.me, marcus: j.marcus, lin: j.lin, aria: j.aria };
      const tally: Record<string, number> = {};
      for (const v of Object.values(labels)) tally[v] = (tally[v] ?? 0) + 1;
      const majority = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
      const outlier = Object.entries(labels).find(([_, v]) => v !== majority)?.[0] ?? "?";
      md.push(`| ${j.business} | ${(j.creative_name ?? "").slice(0, 25)} | ${j.bucket} | $${j.spend_28d.toFixed(0)} | ${j.roas_28d || "—"} | ${j.v3} | ${j.me} | ${j.marcus} | ${j.lin} | ${j.aria} | **${outlier}** |`);
    }
    if (fourFive.length > 25) md.push(`\n_... and ${fourFive.length - 25} more_`);
  }
  md.push("");
  md.push(`## High disagreement (≥4 unique labels) — ${high_disagree.length} creatives`);
  md.push("");
  if (high_disagree.length > 0) {
    md.push(`| business | name | bucket | spend_28d | roas_28d | v3 | me | Marcus | Lin | Aria |`);
    md.push(`|---|---|---|---:|---:|---|---|---|---|---|`);
    for (const j of high_disagree.slice(0, 30)) {
      md.push(`| ${j.business} | ${(j.creative_name ?? "").slice(0, 25)} | ${j.bucket} | $${j.spend_28d.toFixed(0)} | ${j.roas_28d || "—"} | ${j.v3} | ${j.me} | ${j.marcus} | ${j.lin} | ${j.aria} |`);
    }
    if (high_disagree.length > 30) md.push(`\n_... and ${high_disagree.length - 30} more_`);
  }
  md.push("");

  // v3 vs consensus alignment
  let v3Wins = 0;
  let v3Misses = 0;
  let v3NoConsensus = 0;
  for (const j of joined) {
    if (j.consensus_label === "no_consensus") v3NoConsensus++;
    else if (j.v3 === j.consensus_label) v3Wins++;
    else v3Misses++;
  }
  md.push(`## v3 vs human consensus`);
  md.push("");
  md.push(`- **v3 matches majority consensus**: ${v3Wins}/${total} (${((v3Wins / total) * 100).toFixed(1)}%)`);
  md.push(`- **v3 differs from majority**: ${v3Misses}/${total} (${((v3Misses / total) * 100).toFixed(1)}%)`);
  md.push(`- **No clear consensus among humans+engine**: ${v3NoConsensus}/${total} (${((v3NoConsensus / total) * 100).toFixed(1)}%)`);
  md.push("");

  writeFileSync(resolve(baseDir, "05-comparison.md"), md.join("\n") + "\n");

  console.log(`[compare] wrote ${baseDir}/05-comparison.csv + 05-comparison.md`);
  console.log(`[compare] strong consensus (5/5): ${strong.length}`);
  console.log(`[compare] 4/5 consensus: ${fourFive.length}`);
  console.log(`[compare] high disagreement (≥4 unique): ${high_disagree.length}`);
  console.log(`[compare] v3 matches consensus: ${v3Wins}/${total} (${((v3Wins / total) * 100).toFixed(1)}%)`);
}

main();
