// D078 C2.5 — deterministic fail-first proof of the matrix validator the
// harness exits on. The rejected correction-1 harness logged failures and
// still exited 0, carried a single-string switcherProof, and had no
// actual-route CTA proof: each of those shapes must FAIL this validator,
// and a fully valid artifact must pass with zero failures.
import { describe, expect, it } from "vitest";
import {
  D078_MATRIX_CONTRACT,
  expectedEntryKeys,
  expectedHopChains,
  validateD078Matrix,
  type D078MatrixArtifact,
  type D078SwitchHop,
} from "@/scripts/audits/d078-matrix-contract";

const okScreenshot = { screenshotSize: () => 1024 };

function validHops(): D078SwitchHop[] {
  // C3.3: exactly the DECLARED ordered chains — five hops at 1440 from
  // the seeded start, six at 390 (wrap + walk) — with each hop's own
  // identity proof in the shape the harness records.
  const chains = expectedHopChains();
  const hops: D078SwitchHop[] = [];
  for (const width of [1440, 390]) {
    for (const step of chains[width]!) {
      hops.push({
        width,
        from: step.from,
        to: step.to,
        selectedIdentity: `${step.to} ▾`,
        renderedIdentity: `url:${step.to}`,
        pass: true,
      });
    }
  }
  return hops;
}

function validArtifact(): D078MatrixArtifact {
  return {
    contract: D078_MATRIX_CONTRACT,
    switcherProof: validHops(),
    routeCtaProof: { ran: true, exitCode: 0, summary: "3 passed" },
    matrix: expectedEntryKeys().map((key) => {
      const [business, surface, width] = key.split("|");
      return {
        business: business!,
        surface: surface!,
        width: Number(width),
        observed: "rendered",
        assertions: { probe: true },
        screenshot: `shots/${key}.png`,
      };
    }),
  };
}

describe("D078 matrix contract validator (C2.5)", () => {
  it("accepts a fully valid artifact with zero failures", () => {
    expect(validateD078Matrix(validArtifact(), okScreenshot)).toEqual([]);
  });

  it("REJECTS the correction-1 shape: single-string switcherProof and no route CTA proof", () => {
    const artifact = validArtifact();
    (artifact as { switcherProof: unknown }).switcherProof =
      "switched_via_topbar";
    delete (artifact as { routeCtaProof?: unknown }).routeCtaProof;
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some((failure) => failure.includes("rejected correction-1 shape")),
    ).toBe(true);
    expect(
      failures.some((failure) => failure.includes("routeCtaProof missing")),
    ).toBe(true);
  });

  it("fails on any false assertion boolean", () => {
    const artifact = validArtifact();
    artifact.matrix[3]!.assertions.probe = false;
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(failures.some((f) => f.includes("failed assertion"))).toBe(true);
  });

  it("fails on a missing or duplicated required entry", () => {
    const missing = validArtifact();
    missing.matrix.pop();
    expect(
      validateD078Matrix(missing, okScreenshot).some((f) =>
        f.includes("missing matrix entry"),
      ),
    ).toBe(true);

    const duplicated = validArtifact();
    duplicated.matrix.push({ ...duplicated.matrix[0]! });
    expect(
      validateD078Matrix(duplicated, okScreenshot).some((f) =>
        f.includes("duplicate matrix entry"),
      ),
    ).toBe(true);
  });

  it("fails on a missing or zero-byte screenshot", () => {
    const artifact = validArtifact();
    const failures = validateD078Matrix(artifact, {
      screenshotSize: (path) =>
        path.includes("TheSwaf|history|390") ? 0 : 1024,
    });
    expect(
      failures.some((f) => f.includes("missing/empty screenshot file")),
    ).toBe(true);
  });

  it("fails when a width's hop chain does not traverse all six businesses", () => {
    const artifact = validArtifact();
    artifact.switcherProof = (
      artifact.switcherProof as D078SwitchHop[]
    ).filter(
      (hop) =>
        !(hop.width === 390 && (hop.to === "IwaTR" || hop.from === "IwaTR")),
    );
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some((f) => f.includes("390px do not traverse IwaTR")),
    ).toBe(true);
  });

  // ——— C3.3 fail-first matrix: each structural cheat the correction-2
  // name-set validator ACCEPTED must now be a named failure. ———

  function hops(artifact: D078MatrixArtifact): D078SwitchHop[] {
    return artifact.switcherProof as D078SwitchHop[];
  }

  it("REJECTS disconnected hops even when every business name appears (accepted by the correction-2 set check)", () => {
    const artifact = validArtifact();
    // Swap two 390 hops: name coverage is untouched, ordering breaks.
    const at390 = hops(artifact).filter((hop) => hop.width === 390);
    const rest = hops(artifact).filter((hop) => hop.width !== 390);
    [at390[2], at390[4]] = [at390[4]!, at390[2]!];
    artifact.switcherProof = [...rest, ...at390];
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some(
        (f) => f.includes("disconnected") || f.includes("declared chain requires"),
      ),
    ).toBe(true);
  });

  it("REJECTS six self-hops that cover all names without any traversal", () => {
    const artifact = validArtifact();
    artifact.switcherProof = ["TheSwaf", "IwaStore", "Grandmix", "Bilsem Zeka", "IwaTR", "ColorFullWorldsTR"].flatMap(
      (name) =>
        [1440, 390].map((width) => ({
          width,
          from: name,
          to: name,
          selectedIdentity: `${name} ▾`,
          renderedIdentity: `url:${name}`,
          pass: true,
        })),
    );
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(failures.some((f) => f.includes("self switch hop"))).toBe(true);
  });

  it("REJECTS a duplicated target and the missing target it displaces", () => {
    const artifact = validArtifact();
    const grandmix = hops(artifact).find(
      (hop) => hop.width === 390 && hop.to === "Grandmix",
    )!;
    const iwaTr = hops(artifact).find(
      (hop) => hop.width === 390 && hop.to === "IwaTR",
    )!;
    iwaTr.to = "Grandmix";
    iwaTr.selectedIdentity = "Grandmix ▾";
    iwaTr.renderedIdentity = "url:Grandmix";
    void grandmix;
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some((f) => f.includes("duplicate targets")),
    ).toBe(true);
    expect(
      failures.some((f) => f.includes("390px do not traverse IwaTR")),
    ).toBe(true);
  });

  it("REJECTS a hop whose from does not continue the chain", () => {
    const artifact = validArtifact();
    const hop = hops(artifact).find(
      (candidate) => candidate.width === 1440 && candidate.to === "Bilsem Zeka",
    )!;
    hop.from = "TheSwaf";
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some(
        (f) => f.includes("disconnected") || f.includes("declared chain requires"),
      ),
    ).toBe(true);
  });

  it("REJECTS a hop whose selected identity does not name the target", () => {
    const artifact = validArtifact();
    hops(artifact)[0]!.selectedIdentity = "IwaStore ▾";
    // hops[0] targets IwaStore already; break a different one.
    const hop = hops(artifact).find((candidate) => candidate.to === "Grandmix")!;
    hop.selectedIdentity = "TheSwaf ▾";
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some((f) =>
        f.includes("selected identity") && f.includes("Grandmix"),
      ),
    ).toBe(true);
  });

  it("REJECTS a hop whose rendered identity does not prove the target (unknown/error/wrong business)", () => {
    for (const rendered of ["unknown", "error: switch timed out", "url:TheSwaf"]) {
      const artifact = validArtifact();
      const hop = hops(artifact).find((candidate) => candidate.to === "IwaTR")!;
      hop.renderedIdentity = rendered;
      const failures = validateD078Matrix(artifact, okScreenshot);
      expect(
        failures.some(
          (f) => f.includes("rendered identity") && f.includes("IwaTR"),
        ),
      ).toBe(true);
    }
  });

  it("REJECTS a wrong hop count even when every recorded hop is individually valid", () => {
    const artifact = validArtifact();
    // Drop the final 390 hop: names still cover ColorFullWorldsTR via 'from'.
    artifact.switcherProof = hops(artifact).filter(
      (hop, index, all) =>
        !(hop.width === 390 && index === all.length - 1),
    );
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(
      failures.some((f) =>
        f.includes("390px") && f.includes("requires exactly 6"),
      ),
    ).toBe(true);
  });

  it("fails on a failing hop and on a failing route CTA proof", () => {
    const artifact = validArtifact();
    (artifact.switcherProof as D078SwitchHop[])[0]!.pass = false;
    artifact.routeCtaProof = { ran: true, exitCode: 1, summary: "1 failed" };
    const failures = validateD078Matrix(artifact, okScreenshot);
    expect(failures.some((f) => f.includes("switch hop failed"))).toBe(true);
    expect(failures.some((f) => f.includes("routeCtaProof failed"))).toBe(true);
  });
});
