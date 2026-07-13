import { describe, expect, it } from "vitest";
import {
  clusteredMovingBlockBootstrap,
  type BootstrapSampleObservation,
} from "./clustered-moving-block-bootstrap";

interface Row {
  business: string;
  entity: string;
  date: string;
  value: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function date(day: number) {
  return new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
}

function fixture(): Row[] {
  const rows: Row[] = [];
  for (const [businessIndex, business] of ["a", "b"].entries()) {
    for (const [entityIndex, entity] of ["one", "two"].entries()) {
      for (let day = 1; day <= 14; day += 1) {
        rows.push({
          business,
          entity,
          date: date(day),
          value: businessIndex * 100 + entityIndex * 10 + day,
        });
      }
    }
  }
  return rows;
}

function mean(sample: readonly BootstrapSampleObservation<Row>[]) {
  return (
    sample.reduce((sum, row) => sum + row.observation.value, 0) / sample.length
  );
}

function run(seed: string) {
  return clusteredMovingBlockBootstrap(fixture(), {
    getBusinessId: (row) => row.business,
    getEntityId: (row) => row.entity,
    getDate: (row) => row.date,
    statistic: mean,
    seed,
    iterations: 100,
  });
}

describe("clusteredMovingBlockBootstrap", () => {
  it("is exactly reproducible for a fixed seed", () => {
    const first = run("decision-engine-v1");
    const second = run("decision-engine-v1");

    expect(first.estimates).toEqual(second.estimates);
    expect(first).toMatchObject({
      blockLengthDays: 7,
      iterations: 100,
      validIterations: 100,
      invalidIterations: 0,
      businessCount: 2,
      entityCount: 4,
      observationCount: 56,
      pointEstimate: 62.5,
    });
    expect(first.lower).not.toBeNull();
    expect(first.upper).not.toBeNull();
    expect(first.standardError).toBeGreaterThan(0);
  });

  it("changes draws under a different seed", () => {
    expect(run("one").estimates).not.toEqual(run("two").estimates);
  });

  it("keeps every temporal draw inside a seven-calendar-day moving block", () => {
    let inspected = false;
    clusteredMovingBlockBootstrap(fixture(), {
      getBusinessId: (row) => row.business,
      getEntityId: (row) => row.entity,
      getDate: (row) => row.date,
      seed: "inspect-blocks",
      iterations: 1,
      statistic: (sample, context) => {
        if (context.kind === "replicate") {
          const groups = new Map<string, string[]>();
          for (const row of sample) {
            const key = [
              row.bootstrapBusinessInstance,
              row.bootstrapEntityInstance,
              row.temporalBlockInstance,
            ].join(":");
            const dates = groups.get(key) ?? [];
            dates.push(row.date);
            groups.set(key, dates);
          }
          for (const dates of groups.values()) {
            const days = dates.map((value) =>
              Math.floor(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS),
            );
            expect(Math.max(...days) - Math.min(...days)).toBeLessThan(7);
          }
          inspected = true;
        }
        return mean(sample);
      },
    });

    expect(inspected).toBe(true);
  });

  it("keeps sparse trailing observations inside the resampling support", () => {
    const result = clusteredMovingBlockBootstrap<Row>(
      [
        { business: "a", entity: "one", date: "2026-01-01", value: 0 },
        { business: "a", entity: "one", date: "2026-01-20", value: 1 },
      ],
      {
        getBusinessId: (row) => row.business,
        getEntityId: (row) => row.entity,
        getDate: (row) => row.date,
        statistic: mean,
        seed: "sparse-tail",
        iterations: 200,
      },
    );

    expect(result.estimates).toContain(0);
    expect(result.estimates).toContain(1);
  });

  it("tracks null replicates without inventing an interval", () => {
    const result = clusteredMovingBlockBootstrap(fixture(), {
      getBusinessId: (row) => row.business,
      getEntityId: (row) => row.entity,
      getDate: (row) => row.date,
      seed: 7,
      iterations: 5,
      statistic: (_sample, context) => (context.kind === "point" ? 1 : null),
    });

    expect(result).toMatchObject({
      pointEstimate: 1,
      validIterations: 0,
      invalidIterations: 5,
      lower: null,
      median: null,
      upper: null,
      standardError: null,
    });
  });

  it("rejects invalid dates and bootstrap contracts", () => {
    expect(() =>
      clusteredMovingBlockBootstrap(
        [{ business: "a", entity: "one", date: "2026-02-30", value: 1 }],
        {
          getBusinessId: (row) => row.business,
          getEntityId: (row) => row.entity,
          getDate: (row) => row.date,
          statistic: mean,
          seed: "bad-date",
        },
      ),
    ).toThrow("bootstrap dates must be valid ISO calendar dates");
    expect(() =>
      clusteredMovingBlockBootstrap(fixture(), {
        getBusinessId: (row) => row.business,
        getEntityId: (row) => row.entity,
        getDate: (row) => row.date,
        statistic: mean,
        seed: "bad-iterations",
        iterations: 0,
      }),
    ).toThrow("iterations must be a positive integer");
  });
});
