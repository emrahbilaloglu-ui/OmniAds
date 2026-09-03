/**
 * D078 local-UI acceptance matrix contract (correction 2, C2.5).
 *
 * The correction-1 harness computed failures, logged them, and still exited
 * 0 — a future broken matrix could pass unnoticed. This module is the ONE
 * validator both the harness (which must exit nonzero on any violation,
 * after teardown) and the deterministic unit tests share, so the exit guard
 * is provable without breaking a live run.
 */

export interface D078MatrixEntry {
  business: string;
  surface: string;
  width: number;
  observed: string;
  assertions: Record<string, boolean>;
  screenshot: string | null;
}

export interface D078SwitchHop {
  width: number;
  from: string;
  to: string;
  selectedIdentity: string;
  renderedIdentity: string;
  pass: boolean;
}

export interface D078MatrixArtifact {
  contract: string;
  switcherProof: D078SwitchHop[] | string;
  routeCtaProof?: { ran: boolean; exitCode: number | null; summary: string };
  matrix: D078MatrixEntry[];
}

export const D078_MATRIX_CONTRACT =
  "adsecute.meta.d078-local-ui-acceptance-matrix.v3";

export const D078_EXPECTED_BUSINESSES = [
  "IwaStore",
  "Grandmix",
  "Bilsem Zeka",
  "TheSwaf",
  "IwaTR",
  "ColorFullWorldsTR",
] as const;

/** Required surface/width combinations per business. */
export const D078_EXPECTED_SURFACES: ReadonlyArray<{
  surface: string;
  width: number;
  /** Only these businesses carry the combination; undefined = all six. */
  onlyFor?: readonly string[];
}> = [
  { surface: "decisions", width: 1440 },
  { surface: "decisions", width: 390 },
  { surface: "creatives", width: 1440 },
  { surface: "automation", width: 1440 },
  { surface: "history", width: 1440 },
  // C2.4.3: the deselected-scope selection proof also at representative
  // mobile width, on the one business that has a deselected assignment.
  { surface: "history", width: 390, onlyFor: ["TheSwaf"] },
];

export function expectedEntryKeys(): string[] {
  const keys: string[] = [];
  for (const business of D078_EXPECTED_BUSINESSES) {
    for (const combo of D078_EXPECTED_SURFACES) {
      if (combo.onlyFor && !combo.onlyFor.includes(business)) continue;
      keys.push(`${business}|${combo.surface}|${combo.width}`);
    }
  }
  return keys;
}

/**
 * C3.3: the declared ORDERED hop chain per width, from the ONE seeded
 * initial state (active business = TheSwaf, the first declared business).
 *
 * 1440px runs first: five hops walk the declared order from the seeded
 * start. 390px continues from wherever 1440 ended (the last declared
 * business), so it needs the wrap hop back to the start plus the same
 * five — six hops. The correction-2 validator only collected from/to
 * names into a set, which disconnected, self, or duplicate hops could
 * satisfy without any ordered traversal ever happening; the validator now
 * checks the exact chain, continuity, and per-hop identity proof.
 */
export const D078_SWITCH_ORDER = [
  // The seeded initial state IS the first entry; the harness imports this
  // order so the declared chain and the driven chain cannot drift.
  "TheSwaf",
  "IwaStore",
  "Grandmix",
  "Bilsem Zeka",
  "IwaTR",
  "ColorFullWorldsTR",
] as const;

export function expectedHopChains(): Record<
  number,
  Array<{ from: string; to: string }>
> {
  const order = [...D078_SWITCH_ORDER];
  const walk = order
    .slice(1)
    .map((to, index) => ({ from: order[index]!, to }));
  return {
    1440: walk,
    390: [{ from: order[order.length - 1]!, to: order[0]! }, ...walk],
  };
}

/**
 * Validate the artifact. Returns a list of human-readable failures; empty
 * means the matrix satisfies the declared contract. Screenshot existence is
 * probed through the injected `screenshotSize` so unit tests can simulate
 * missing/zero-byte files without touching the filesystem.
 */
export function validateD078Matrix(
  artifact: D078MatrixArtifact,
  input: { screenshotSize: (path: string) => number | null },
): string[] {
  const failures: string[] = [];

  if (artifact.contract !== D078_MATRIX_CONTRACT) {
    failures.push(
      `contract mismatch: ${artifact.contract} (expected ${D078_MATRIX_CONTRACT})`,
    );
  }

  // Matrix shape: exactly the declared entry set, no missing, no duplicate.
  const expected = new Set(expectedEntryKeys());
  const seen = new Map<string, number>();
  for (const entry of artifact.matrix ?? []) {
    const key = `${entry.business}|${entry.surface}|${entry.width}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const key of expected) {
    const count = seen.get(key) ?? 0;
    if (count === 0) failures.push(`missing matrix entry: ${key}`);
    if (count > 1) failures.push(`duplicate matrix entry: ${key} ×${count}`);
  }
  for (const key of seen.keys()) {
    if (!expected.has(key)) failures.push(`unexpected matrix entry: ${key}`);
  }

  // Every assertion boolean must be true; every screenshot must exist and
  // be non-empty.
  for (const entry of artifact.matrix ?? []) {
    for (const [name, ok] of Object.entries(entry.assertions ?? {})) {
      if (!ok) {
        failures.push(
          `failed assertion ${entry.business}/${entry.surface}@${entry.width}: ${name}`,
        );
      }
    }
    if (!entry.screenshot) {
      failures.push(
        `missing screenshot path: ${entry.business}/${entry.surface}@${entry.width}`,
      );
    } else {
      const size = input.screenshotSize(entry.screenshot);
      if (size === null || size <= 0) {
        failures.push(`missing/empty screenshot file: ${entry.screenshot}`);
      }
    }
  }

  // Switch hops: a machine-readable array (a bare string is the rejected
  // correction-1 shape), every hop passing, and — C3.3 — per width the
  // hops must BE the declared ordered chain: exact count, no self-hop, no
  // duplicate target, from-continuity, all six businesses reached in
  // order, and each hop's own identity proof pinned (selected identity
  // names the target; rendered identity proves the target, never
  // unknown/error). A name-coverage set is no longer sufficient.
  if (!Array.isArray(artifact.switcherProof)) {
    failures.push(
      "switcherProof is not a hop array (single-string proof is the rejected correction-1 shape)",
    );
  } else {
    for (const [index, hop] of artifact.switcherProof.entries()) {
      if (!hop.pass) {
        failures.push(
          `switch hop failed [${index}] ${hop.width}px ${hop.from}→${hop.to}: selected=${hop.selectedIdentity} rendered=${hop.renderedIdentity}`,
        );
      }
      if (hop.from === hop.to) {
        failures.push(
          `self switch hop [${index}] ${hop.width}px ${hop.from}→${hop.to}: a self-hop proves no traversal`,
        );
      }
      if (!String(hop.selectedIdentity ?? "").includes(hop.to)) {
        failures.push(
          `switch hop [${index}] ${hop.width}px selected identity "${hop.selectedIdentity}" does not name the target ${hop.to}`,
        );
      }
      const rendered = String(hop.renderedIdentity ?? "");
      if (rendered !== `url:${hop.to}` && rendered !== `body:${hop.to}`) {
        failures.push(
          `switch hop [${index}] ${hop.width}px rendered identity "${hop.renderedIdentity}" does not prove the target ${hop.to}`,
        );
      }
    }
    const chains = expectedHopChains();
    for (const width of [1440, 390]) {
      const hops = artifact.switcherProof.filter((hop) => hop.width === width);
      const chain = chains[width]!;
      if (hops.length !== chain.length) {
        failures.push(
          `switch hops at ${width}px: ${hops.length} hops recorded, the declared chain requires exactly ${chain.length}`,
        );
      }
      const targets = new Map<string, number>();
      for (const hop of hops) {
        targets.set(hop.to, (targets.get(hop.to) ?? 0) + 1);
      }
      for (const [target, count] of targets) {
        if (count > 1) {
          failures.push(
            `switch hops at ${width}px visit target ${target} ×${count}: duplicate targets prove no single ordered traversal`,
          );
        }
      }
      for (const [index, hop] of hops.entries()) {
        if (index > 0 && hop.from !== hops[index - 1]!.to) {
          failures.push(
            `switch hops at ${width}px are disconnected at [${index}]: from ${hop.from} does not equal the preceding hop's target ${hops[index - 1]!.to}`,
          );
        }
        const expectedHop = chain[index];
        if (
          expectedHop &&
          (hop.from !== expectedHop.from || hop.to !== expectedHop.to)
        ) {
          failures.push(
            `switch hop at ${width}px [${index}] is ${hop.from}→${hop.to}; the declared chain requires ${expectedHop.from}→${expectedHop.to}`,
          );
        }
      }
      const reached = new Set(hops.map((hop) => hop.to));
      if (width === 1440) reached.add(chain[0]!.from);
      for (const business of D078_EXPECTED_BUSINESSES) {
        if (!reached.has(business)) {
          failures.push(
            `switch hops at ${width}px do not traverse ${business}`,
          );
        }
      }
    }
  }

  // The actual-route CTA proof must have run and passed (C2.2).
  if (!artifact.routeCtaProof?.ran) {
    failures.push("routeCtaProof missing: the actual-route CTA proof did not run");
  } else if (artifact.routeCtaProof.exitCode !== 0) {
    failures.push(
      `routeCtaProof failed: exit ${artifact.routeCtaProof.exitCode} (${artifact.routeCtaProof.summary})`,
    );
  }

  return failures;
}
