import { MetaAiTagKey } from "@/components/creatives/metricConfig";

export type AiTagPillTone = {
  className: string;
};

type AiTagToneMap = Partial<Record<MetaAiTagKey, Record<string, AiTagPillTone>>>;

function makeTone(className: string): AiTagPillTone {
  return { className };
}

const BASE_NONE_TONE = makeTone("border-neutral-200 bg-neutral-50 text-neutral-600");

const AI_TAG_COLOR_MAP: AiTagToneMap = {
  assetType: {
    Animation: makeTone("border-pink-200 bg-pink-50 text-pink-700"),
    UGC: makeTone("border-emerald-200 bg-emerald-50 text-emerald-700"),
    "Product Image": makeTone("border-lime-200 bg-lime-50 text-lime-700"),
    "Product Image with Text": makeTone("border-rose-200 bg-rose-50 text-rose-700"),
    Hybrid: makeTone("border-blue-200 bg-blue-50 text-blue-700"),
    Other: makeTone("border-neutral-200 bg-neutral-50 text-neutral-700"),
    None: BASE_NONE_TONE,
  },
  visualFormat: {
    "Cinematic B-Roll": makeTone("border-amber-200 bg-amber-50 text-amber-700"),
    Headline: makeTone("border-purple-200 bg-purple-50 text-purple-700"),
    Demo: makeTone("border-cyan-200 bg-cyan-50 text-cyan-700"),
    Montage: makeTone("border-teal-200 bg-teal-50 text-teal-700"),
    Founder: makeTone("border-lime-200 bg-lime-50 text-lime-800"),
    "Time Lapse": makeTone("border-sky-200 bg-sky-50 text-sky-700"),
    "Behind The Scenes": makeTone("border-yellow-200 bg-yellow-50 text-yellow-700"),
    None: makeTone("border-emerald-100 bg-emerald-50 text-emerald-700"),
  },
  intendedAudience: {
    Founder: makeTone("border-sky-200 bg-sky-50 text-sky-700"),
    "Ecommerce Shopper": makeTone("border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700"),
    "First-time Buyer": makeTone("border-blue-200 bg-blue-50 text-blue-700"),
    None: BASE_NONE_TONE,
  },
  messagingAngle: {
    Nostalgia: makeTone("border-orange-200 bg-orange-50 text-orange-700"),
    "Problem Solution": makeTone("border-sky-200 bg-sky-50 text-sky-700"),
    "Social Proof": makeTone("border-emerald-200 bg-emerald-50 text-emerald-700"),
    Benefit: makeTone("border-cyan-200 bg-cyan-50 text-cyan-700"),
    None: BASE_NONE_TONE,
  },
  seasonality: {
    Holiday: makeTone("border-red-200 bg-red-50 text-red-700"),
    Summer: makeTone("border-yellow-200 bg-yellow-50 text-yellow-700"),
    Winter: makeTone("border-sky-200 bg-sky-50 text-sky-700"),
    Evergreen: makeTone("border-emerald-200 bg-emerald-50 text-emerald-700"),
    None: BASE_NONE_TONE,
  },
  offerType: {
    Discount: makeTone("border-rose-200 bg-rose-50 text-rose-700"),
    Bundle: makeTone("border-purple-200 bg-purple-50 text-purple-700"),
    "Free Shipping": makeTone("border-cyan-200 bg-cyan-50 text-cyan-700"),
    "Limited Time": makeTone("border-amber-200 bg-amber-50 text-amber-700"),
    None: BASE_NONE_TONE,
  },
  hookTactic: {
    "Question Hook": makeTone("border-sky-200 bg-sky-50 text-sky-700"),
    "Pattern Interrupt": makeTone("border-pink-200 bg-pink-50 text-pink-700"),
    "Shock Statement": makeTone("border-red-200 bg-red-50 text-red-700"),
    "Before/After": makeTone("border-teal-200 bg-teal-50 text-teal-700"),
    None: BASE_NONE_TONE,
  },
  headlineTactic: {
    "Benefit Headline": makeTone("border-emerald-200 bg-emerald-50 text-emerald-700"),
    "Curiosity Headline": makeTone("border-cyan-200 bg-cyan-50 text-cyan-700"),
    "How To": makeTone("border-blue-200 bg-blue-50 text-blue-700"),
    "Number Headline": makeTone("border-amber-200 bg-amber-50 text-amber-700"),
    None: BASE_NONE_TONE,
  },
};

const CATEGORY_FALLBACK_TONES: Record<MetaAiTagKey, AiTagPillTone> = {
  assetType: makeTone("border-emerald-200 bg-emerald-50 text-emerald-700"),
  visualFormat: makeTone("border-sky-200 bg-sky-50 text-sky-700"),
  intendedAudience: makeTone("border-sky-200 bg-sky-50 text-sky-700"),
  messagingAngle: makeTone("border-cyan-200 bg-cyan-50 text-cyan-700"),
  seasonality: makeTone("border-amber-200 bg-amber-50 text-amber-700"),
  offerType: makeTone("border-rose-200 bg-rose-50 text-rose-700"),
  hookTactic: makeTone("border-pink-200 bg-pink-50 text-pink-700"),
  headlineTactic: makeTone("border-teal-200 bg-teal-50 text-teal-700"),
};

function normalizeTagValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findNormalizedTone(
  entries: Record<string, AiTagPillTone>,
  value: string
): AiTagPillTone | null {
  const normalizedValue = normalizeTagValue(value);

  for (const [key, tone] of Object.entries(entries)) {
    if (normalizeTagValue(key) === normalizedValue) {
      return tone;
    }
  }

  return null;
}

export function getAiTagPillStyles(category: MetaAiTagKey, value: string): AiTagPillTone {
  const entries = AI_TAG_COLOR_MAP[category];
  const fallbackTone = CATEGORY_FALLBACK_TONES[category];

  if (!entries) return fallbackTone;

  const exactTone = entries[value];
  if (exactTone) return exactTone;

  return findNormalizedTone(entries, value) ?? fallbackTone;
}
