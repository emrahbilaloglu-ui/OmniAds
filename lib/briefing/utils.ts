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

export function formatCurrency(value: number | null | undefined): string {
  return `$${Math.round(value || 0).toLocaleString("en-US")}`;
}

export function formatRoas(value: number | null | undefined): string {
  return `${(value || 0).toFixed(2)}×`;
}

export function formatPercent(
  value: number,
  digits = 0,
  opts: { signed?: boolean } = {},
): string {
  const sign = opts.signed && value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function sparklinePath(values: number[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return "M0.0,16.0";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 60;
  const height = 16;
  const step = width / (values.length - 1);

  return values
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - ((value - min) / range) * height).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

export function initials(name: string): string {
  return name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export function tileFor(name: string): [string, string] {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return TILE_PALETTE[Math.abs(hash) % TILE_PALETTE.length];
}
