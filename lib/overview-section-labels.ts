/**
 * Disambiguation for Overview platform sections.
 *
 * Overview builds one section per platform-efficiency row. Two rows can resolve
 * to the same friendly provider label ("Meta Ads"), which previously rendered as
 * two identically titled sections showing different totals — the reader had no
 * way to tell which scope each number belonged to, and no way to tell whether
 * one of them was simply wrong.
 *
 * These helpers never invent an account name. They surface the identity the
 * section already carries, and when that identity cannot separate two sections
 * they mark the pair ambiguous so the UI can say so instead of implying the
 * numbers are comparable.
 */

export interface PlatformSectionIdentity {
  id: string;
  title: string;
  provider: string;
}

export interface ResolvedSectionLabel {
  /** Friendly provider label, e.g. "Meta Ads". */
  providerLabel: string;
  /** Extra identity shown only when it is needed to tell sections apart. */
  qualifier: string | null;
  /**
   * True when two sections share a provider label and carry no distinguishing
   * identity. The UI must disclose this rather than showing twin totals.
   */
  ambiguous: boolean;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve a display label per section, in the same order as the input.
 *
 * @param sections sections as rendered on Overview
 * @param providerLabel maps a provider key to its friendly label
 */
export function resolvePlatformSectionLabels(
  sections: PlatformSectionIdentity[],
  providerLabel: (provider: string) => string,
): ResolvedSectionLabel[] {
  const labelCounts = new Map<string, number>();
  for (const section of sections) {
    const label = providerLabel(section.provider);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  return sections.map((section) => {
    const label = providerLabel(section.provider);
    const shares = (labelCounts.get(label) ?? 0) > 1;

    if (!shares) {
      return { providerLabel: label, qualifier: null, ambiguous: false };
    }

    // The section's own title is the only identity we hold. Use it when it adds
    // information beyond the provider label itself.
    const title = section.title?.trim() ?? "";
    const addsInformation = title.length > 0 && normalize(title) !== normalize(label);

    if (addsInformation) {
      return { providerLabel: label, qualifier: title, ambiguous: false };
    }

    // Same provider label, same title: the sections cannot be told apart from
    // the data we have. Fall back to the section id if it distinguishes them.
    const siblings = sections.filter(
      (candidate) => normalize(providerLabel(candidate.provider)) === normalize(label),
    );
    const idsDiffer = new Set(siblings.map((candidate) => candidate.id)).size === siblings.length;
    if (idsDiffer && section.id.trim()) {
      return { providerLabel: label, qualifier: section.id.trim(), ambiguous: true };
    }

    return { providerLabel: label, qualifier: null, ambiguous: true };
  });
}
