/**
 * The "attention story" shown to the creative_team audience.
 *
 * A plain metric table answers "what happened"; this answers "so what" — did
 * the creative earn attention, hold it, and convert it — in one sentence a
 * non-analyst can act on. Every claim here has to be backed by a REAL served
 * number, and every comparison against "typical" has to be backed by a REAL
 * measured benchmark, computed server-side from the account's own other
 * creatives at share-creation time (`CreativeShareBenchmarks`). A metric with
 * no benchmark gets no Strong/Typical/Weak verdict — the raw number still
 * renders, honestly unbanded, rather than a fabricated comparison.
 *
 * The public payload has no aspect-ratio, hold-15s or duration field. Nothing
 * here invents one.
 */
import type {
  CreativeShareBenchmarks,
  SharePayloadCreative,
} from "@/components/creatives/shareCreativeTypes";

export type CreativeStoryBand = "Strong" | "Typical" | "Weak" | null;

export interface CreativeStoryStage {
  key: "hook" | "hold" | "click";
  label: string;
  plainText: string;
  valueLabel: string;
  /** The account's own typical value at this stage, formatted; null when there is no benchmark. */
  benchmarkValueLabel: string | null;
  band: CreativeStoryBand;
  /** 0-100, the bar fill. Scaled for legibility, never clipping a real value out of view. */
  widthPercent: number;
  /** 0-100 tick position for the benchmark marker; null when there is no benchmark. */
  benchmarkPercent: number | null;
}

export interface CreativeStory {
  tone: "good" | "mixed" | "bad" | "unclear";
  /** null when no stage carries a real benchmark — nothing here to verdict. */
  verdict: string | null;
  stages: CreativeStoryStage[];
  dropOff: Array<{ label: string; heightPercent: number; highlighted: boolean }> | null;
  dropOffCaption: string | null;
  suggestion: string | null;
  /** The raw measured numbers behind the narrative above, for anyone who wants them. */
  rawLine: string;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function band(value: number, benchmark: number | null): CreativeStoryBand {
  if (benchmark === null || benchmark <= 0) return null;
  if (value >= benchmark * 1.15) return "Strong";
  if (value >= benchmark * 0.85) return "Typical";
  return "Weak";
}

function scaledWidth(value: number, benchmark: number | null, softCeiling: number): number {
  const ceiling = Math.max(value, benchmark ?? 0, softCeiling) * 1.15;
  if (ceiling <= 0) return 0;
  return Math.min(100, Math.round((value / ceiling) * 1000) / 10);
}

function benchmarkPercent(benchmark: number | null, value: number, softCeiling: number): number | null {
  if (benchmark === null) return null;
  const ceiling = Math.max(value, benchmark, softCeiling) * 1.15;
  if (ceiling <= 0) return null;
  return Math.min(96, Math.round((benchmark / ceiling) * 1000) / 10);
}

function pct(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

const HOOK_STAGE = (thumbstop: number, benchmark: number | null): CreativeStoryStage => ({
  key: "hook",
  label: "Stops the scroll",
  plainText: `${thumbstop.toFixed(0)} of 100 people pause on it`,
  valueLabel: pct(thumbstop),
  benchmarkValueLabel: benchmark !== null ? pct(benchmark) : null,
  band: band(thumbstop, benchmark),
  widthPercent: scaledWidth(thumbstop, benchmark, 40),
  benchmarkPercent: benchmarkPercent(benchmark, thumbstop, 40),
});

const HOLD_STAGE = (video50: number, benchmark: number | null): CreativeStoryStage => ({
  key: "hold",
  label: "Keeps them watching",
  plainText: `${video50.toFixed(0)} of 100 are still watching at halfway`,
  valueLabel: pct(video50),
  benchmarkValueLabel: benchmark !== null ? pct(benchmark) : null,
  band: band(video50, benchmark),
  widthPercent: scaledWidth(video50, benchmark, 40),
  benchmarkPercent: benchmarkPercent(benchmark, video50, 40),
});

const CLICK_STAGE = (ctr: number, benchmark: number | null): CreativeStoryStage => ({
  key: "click",
  label: "Earns the click",
  plainText: `${Math.round(ctr * 10)} of 1,000 viewers click through`,
  valueLabel: pct(ctr, 2),
  benchmarkValueLabel: benchmark !== null ? pct(benchmark, 2) : null,
  band: band(ctr, benchmark),
  widthPercent: scaledWidth(ctr, benchmark, 2.5),
  benchmarkPercent: benchmarkPercent(benchmark, ctr, 2.5),
});

function bandOf(stages: CreativeStoryStage[], key: CreativeStoryStage["key"]): CreativeStoryBand {
  return stages.find((stage) => stage.key === key)?.band ?? null;
}

function buildVerdict(
  stages: CreativeStoryStage[],
): { tone: CreativeStory["tone"]; verdict: string | null; suggestion: string | null } {
  const hookB = bandOf(stages, "hook");
  const holdB = bandOf(stages, "hold");
  const clickB = bandOf(stages, "click");
  const banded = stages.filter((stage) => stage.band !== null);
  if (banded.length === 0) {
    return { tone: "unclear", verdict: null, suggestion: null };
  }
  const weak = banded.filter((stage) => stage.band === "Weak").length;
  const strong = banded.filter((stage) => stage.band === "Strong").length;
  const hasHook = stages.some((stage) => stage.key === "hook");

  if (!hasHook) {
    if (clickB === "Strong") {
      return {
        tone: "good",
        verdict: "Earns clicks well above the account's typical creative.",
        suggestion:
          "Working well — brief one variant with a stronger offer line to push clicks further.",
      };
    }
    if (clickB === "Weak") {
      return {
        tone: "bad",
        verdict: "Too few people click through relative to the account's typical creative.",
        suggestion: "Test one variable at a time: swap the headline, keep the visual unchanged.",
      };
    }
    return { tone: "mixed", verdict: "Around typical — clicks are fine, nothing stands out.", suggestion: null };
  }
  if (hookB === "Weak") {
    return {
      tone: "bad",
      verdict: "Most viewers scroll straight past — the opening moment isn't earning attention.",
      suggestion: "Reshoot the first second: product in motion, no logo or text, before anything else.",
    };
  }
  if (weak === 0 && strong >= 2) {
    return {
      tone: "good",
      verdict: "Healthy across the board: it stops the scroll, holds attention and earns the click.",
      suggestion: "Keep it running — brief a same-voice variant now so a fresh opener is ready before wear sets in.",
    };
  }
  if (clickB === "Weak") {
    return {
      tone: "mixed",
      verdict: "It stops the scroll, but too few click through — the hook isn't paying off.",
      suggestion: "Add an explicit end-card with a single offer line — attention exists, the ask is missing.",
    };
  }
  if (holdB === "Weak") {
    return {
      tone: "mixed",
      verdict: "People stop for it, but leave early — the middle loses them.",
      suggestion: "Tighten the middle — cut to the payoff earlier; the message lands after most viewers have left.",
    };
  }
  if (weak === 0) {
    return {
      tone: "good",
      verdict: "Healthy read — at or above the account's typical creative at every measured stage.",
      suggestion: null,
    };
  }
  return {
    tone: "mixed",
    verdict: "Mixed read — one stage is dragging; see the bar below.",
    suggestion: "Test one variable at a time, keeping pacing and copy unchanged otherwise.",
  };
}

const TONE_STYLE: Record<CreativeStory["tone"], { bg: string; fg: string; border: string }> = {
  good: { bg: "#F3FBF7", fg: "#0F7A54", border: "#BFE5D6" },
  mixed: { bg: "#FDF8EC", fg: "#8A4B06", border: "#EBD6A4" },
  bad: { bg: "#FDECF0", fg: "#B0123F", border: "#F6C6D2" },
  unclear: { bg: "#F1F4F9", fg: "#45526B", border: "#E4E8F0" },
};

export function toneStyle(tone: CreativeStory["tone"]) {
  return TONE_STYLE[tone];
}

/**
 * Build the story for one creative, or null when there is nothing honest to
 * build one from (format has no video/thumbstop/CTR signal at all).
 */
export function buildCreativeStory(
  creative: Pick<SharePayloadCreative, "format" | "thumbstop" | "ctrAll" | "video25" | "video50" | "video75" | "video100">,
  benchmarks: CreativeShareBenchmarks | undefined,
): CreativeStory | null {
  const isVideo = creative.format === "video";
  const isCatalog = creative.format === "catalog";
  const thumbstop = finite(creative.thumbstop);
  const ctr = finite(creative.ctrAll);
  const video50 = finite(creative.video50);

  const stages: CreativeStoryStage[] = [];
  if (thumbstop !== null && (isVideo || isCatalog)) {
    stages.push(HOOK_STAGE(thumbstop, finite(benchmarks?.thumbstop)));
  }
  if (isVideo && video50 !== null) {
    stages.push(HOLD_STAGE(video50, finite(benchmarks?.videoCompletion50)));
  }
  if (ctr !== null) {
    stages.push(CLICK_STAGE(ctr, finite(benchmarks?.ctrAll)));
  }
  if (stages.length === 0) return null;

  const { tone, verdict, suggestion } = buildVerdict(stages);

  const quartiles = [
    finite(creative.video25),
    finite(creative.video50),
    finite(creative.video75),
    finite(creative.video100),
  ];
  let dropOff: CreativeStory["dropOff"] = null;
  let dropOffCaption: string | null = null;
  if (isVideo && quartiles.every((value): value is number => value !== null)) {
    const bars = [100, ...quartiles];
    const labels = ["start", "1/4", "1/2", "3/4", "end"];
    let biggestIndex = 0;
    let biggestDrop = -1;
    for (let index = 0; index < 4; index += 1) {
      const drop = bars[index]! - bars[index + 1]!;
      if (drop > biggestDrop) {
        biggestDrop = drop;
        biggestIndex = index;
      }
    }
    dropOff = bars.map((value, index) => ({
      label: labels[index]!,
      heightPercent: Math.max(4, value),
      // The bar where the biggest loss lands, so the eye goes straight to it.
      highlighted: index === biggestIndex + 1,
    }));
    const segmentNames = ["the opening quarter", "the second quarter", "the third quarter", "the final stretch"];
    dropOffCaption = `Biggest loss: ${segmentNames[biggestIndex]} — ${biggestDrop.toFixed(0)} of 100 viewers leave there.`;
  }

  const RAW_LINE_LABEL: Record<CreativeStoryStage["key"], string> = {
    hook: "Thumbstop",
    hold: "Video 50%",
    click: "CTR",
  };
  const rawLine = stages.map((stage) => `${RAW_LINE_LABEL[stage.key]} ${stage.valueLabel}`).join(" · ");

  return { tone, verdict, stages, dropOff, dropOffCaption, suggestion: verdict ? suggestion : null, rawLine };
}
