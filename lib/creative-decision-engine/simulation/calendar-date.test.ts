import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizePostgresDate } from "./calendar-date";

describe("normalizePostgresDate", () => {
  it("accepts valid PostgreSQL DATE strings and rejects non-date values", () => {
    expect(normalizePostgresDate(" 2026-07-12 ")).toBe("2026-07-12");
    expect(normalizePostgresDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizePostgresDate("2026-02-29")).toBeNull();
    expect(normalizePostgresDate("2026-13-01")).toBeNull();
    expect(normalizePostgresDate("2026-07-12T00:00:00.000Z")).toBeNull();
    expect(normalizePostgresDate(null)).toBeNull();
    expect(normalizePostgresDate(new Date(Number.NaN))).toBeNull();
  });

  it.each(["UTC", "Europe/Istanbul", "America/Los_Angeles"])(
    "keeps a local-midnight PostgreSQL DATE on the same day under %s",
    (timezone) => {
      const moduleUrl = pathToFileURL(
        resolve(
          process.cwd(),
          "lib/creative-decision-engine/simulation/calendar-date.ts",
        ),
      ).href;
      const source = `
        const calendarDateModule = await import(${JSON.stringify(moduleUrl)});
        const normalizePostgresDate =
          calendarDateModule.normalizePostgresDate ??
          calendarDateModule.default?.normalizePostgresDate;
        const { default: parsePostgresDate } = await import("postgres-date");
        const pgDate = parsePostgresDate("2026-07-12");
        process.stdout.write(JSON.stringify({
          normalized: normalizePostgresDate(pgDate),
          localHour: pgDate.getHours(),
          legacyUtcDay: pgDate.toISOString().slice(0, 10),
        }));
      `;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, TZ: timezone },
          },
        ),
      ) as {
        normalized: string | null;
        localHour: number;
        legacyUtcDay: string;
      };

      expect(result.localHour).toBe(0);
      expect(result.normalized).toBe("2026-07-12");
      if (timezone === "Europe/Istanbul") {
        expect(result.legacyUtcDay).toBe("2026-07-11");
      }
    },
  );

  it("rejects Date instances that carry timestamp rather than DATE semantics", () => {
    expect(normalizePostgresDate(new Date(2026, 6, 12, 12, 30))).toBeNull();
  });
});
