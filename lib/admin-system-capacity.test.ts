import { describe, expect, it } from "vitest";
import {
  classifyCapacityStatus,
  parseDfOutput,
  summarizeAdminSystemCapacity,
  type AdminSystemCapacityPayload,
} from "@/lib/admin-system-capacity";

const thresholds = {
  warningPercent: 85,
  criticalPercent: 95,
};

describe("admin system capacity helpers", () => {
  it("classifies disk capacity against warning and critical thresholds", () => {
    expect(classifyCapacityStatus(42, thresholds)).toBe("ok");
    expect(classifyCapacityStatus(85, thresholds)).toBe("warning");
    expect(classifyCapacityStatus(95, thresholds)).toBe("critical");
    expect(classifyCapacityStatus(null, thresholds)).toBe("unknown");
  });

  it("parses POSIX df output into byte metrics", () => {
    const parsed = parseDfOutput(
      "/",
      [
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/sda1 157197504 62183312 88572936 42% /",
      ].join("\n"),
      thresholds,
    );

    expect(parsed).toMatchObject({
      path: "/",
      filesystem: "/dev/sda1",
      mountedOn: "/",
      usedPercent: 42,
      status: "ok",
      error: null,
    });
    expect(parsed.totalBytes).toBe(157197504 * 1024);
    expect(parsed.availableBytes).toBe(88572936 * 1024);
  });

  it("summarizes the first available disk and largest relation", () => {
    const payload: AdminSystemCapacityPayload = {
      sampledAt: "2026-05-29T00:00:00.000Z",
      status: "ok",
      thresholds,
      database: {
        databaseName: "adsecute_prod",
        userName: "adsecute_app",
        serverAddress: "127.0.0.1",
        serverPort: 5432,
        sizeBytes: 117_309_651_991,
        sizePretty: "109 GB",
        topRelations: [
          {
            schema: "public",
            relation: "meta_config_snapshots",
            relationKind: "table",
            totalBytes: 22_832_365_568,
            tableBytes: 14_722_662_400,
            indexBytes: 8_109_703_168,
          },
        ],
      },
      dbHostDisks: [],
      runtimeDisks: [
        {
          path: "/missing",
          filesystem: null,
          mountedOn: null,
          totalBytes: null,
          usedBytes: null,
          availableBytes: null,
          usedPercent: null,
          status: "unknown",
          source: "df",
          host: null,
          error: "missing",
        },
        {
          path: "/",
          filesystem: "/dev/sda1",
          mountedOn: "/",
          totalBytes: 160_970_244_096,
          usedBytes: 63_675_711_488,
          availableBytes: 90_698_686_464,
          usedPercent: 42,
          status: "ok",
          source: "df",
          host: null,
          error: null,
        },
      ],
      runtimeDiskSource: "local_runtime",
      runtimeHost: "test-runtime",
      runtimePlatform: "linux",
      runtimeIsProdServer: false,
      disks: [
        {
          path: "/missing",
          filesystem: null,
          mountedOn: null,
          totalBytes: null,
          usedBytes: null,
          availableBytes: null,
          usedPercent: null,
          status: "unknown",
          source: "df",
          host: null,
          error: "missing",
        },
        {
          path: "/",
          filesystem: "/dev/sda1",
          mountedOn: "/",
          totalBytes: 160_970_244_096,
          usedBytes: 63_675_711_488,
          availableBytes: 90_698_686_464,
          usedPercent: 42,
          status: "ok",
          source: "df",
          host: null,
          error: null,
        },
      ],
      diskSource: "local_runtime",
      diskSnapshotAt: null,
      notes: [],
    };

    expect(summarizeAdminSystemCapacity(payload)).toMatchObject({
      status: "ok",
      databaseSizePretty: "109 GB",
      diskUsedPercent: 42,
      diskPath: "/",
      topRelation: "public.meta_config_snapshots",
    });
  });
});
