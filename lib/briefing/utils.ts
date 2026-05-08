const TILE_PALETTE: Array<[string, string]> = [
  ["bg-slate-800", "text-slate-50"],
  ["bg-indigo-700", "text-indigo-50"],
  ["bg-emerald-700", "text-emerald-50"],
  ["bg-rose-700", "text-rose-50"],
  ["bg-amber-600", "text-amber-50"],
  ["bg-sky-700", "text-sky-50"],
  ["bg-violet-700", "text-violet-50"],
  ["bg-teal-700", "text-teal-50"],
  ["bg-stone-700", "text-stone-50"],
  ["bg-cyan-800", "text-cyan-50"],
];

function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function safeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatCurrency(value: unknown): string {
  return `$${Math.round(finiteNumber(value)).toLocaleString("en-US")}`;
}

export function formatRoas(value: unknown): string {
  return `${finiteNumber(value).toFixed(2)}×`;
}

export function formatPercent(
  value: unknown,
  digits = 0,
  opts: { signed?: boolean } = {},
): string {
  const numeric = finiteNumber(value);
  const sign = opts.signed && numeric >= 0 ? "+" : "";
  return `${sign}${numeric.toFixed(digits)}%`;
}

export function sparklinePath(values: unknown[]): string {
  const normalizedValues = values
    .map(finiteNumberOrNull)
    .filter((value): value is number => value != null);
  if (normalizedValues.length === 0) return "";
  if (normalizedValues.length === 1) return "M0.0,16.0";

  const min = Math.min(...normalizedValues);
  const max = Math.max(...normalizedValues);
  const range = max - min || 1;
  const width = 60;
  const height = 16;
  const step = width / (normalizedValues.length - 1);

  return normalizedValues
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - ((value - min) / range) * height).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

export function initials(name: unknown): string {
  return safeText(name, "Creative")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export function tileFor(name: unknown): [string, string] {
  const safeName = safeText(name, "Creative");
  let hash = 0;
  for (let index = 0; index < safeName.length; index += 1) {
    hash = (hash * 31 + safeName.charCodeAt(index)) | 0;
  }
  return TILE_PALETTE[Math.abs(hash) % TILE_PALETTE.length];
}
