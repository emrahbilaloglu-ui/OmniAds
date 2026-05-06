import { describe, expect, it } from "vitest";
import {
  IntegrationSecretKeyRequiredError,
  IntegrationSecretUnreadableError,
} from "@/lib/integration-secrets";
import {
  assessRuntimeTokenReadability,
  buildRuntimeTokenReadabilityBlocker,
  classifyRuntimeCandidateSkip,
  classifyRuntimeTokenReadabilityError,
  countRuntimeSkippedCandidates,
  createEmptyCoverageSummary,
  hasIntegrationTokenDecryptionKey,
  isIntegrationCredentialReadabilityError,
  recordCoverage,
  resolveCandidateSkipReason,
  shouldReportNoLiveReadableBusinesses,
  summarizeCandidateEligibility,
  type SourceBusinessRow,
} from "./creative-segmentation-calibration-lab";

function candidate(overrides: Partial<SourceBusinessRow>): SourceBusinessRow {
  return {
    business_id: "business",
    max_end_date: "2026-04-22",
    max_row_count: 1,
    latest_synced_at: "2026-04-23T00:00:00.000Z",
    connection_status: "connected",
    has_access_token: true,
    has_encrypted_access_token: true,
    assigned_account_count: 1,
    ...overrides,
  };
}

describe("creative segmentation calibration lab helpers", () => {
  it("skips historical snapshot businesses that are not currently Meta eligible", () => {
    expect(resolveCandidateSkipReason(candidate({ connection_status: null }))).toBe(
      "no_current_meta_connection",
    );
    expect(resolveCandidateSkipReason(candidate({ connection_status: "disconnected" }))).toBe(
      "meta_connection_not_connected",
    );
    expect(resolveCandidateSkipReason(candidate({ has_access_token: false }))).toBe(
      "no_access_token",
    );
    expect(resolveCandidateSkipReason(candidate({ assigned_account_count: 0 }))).toBe(
      "no_accounts_assigned",
    );
    expect(resolveCandidateSkipReason(candidate({}))).toBeNull();
  });

  it("summarizes eligible and skipped candidates without exposing raw ids", () => {
    const summary = summarizeCandidateEligibility([
      candidate({ business_id: "raw-business-1" }),
      candidate({ business_id: "raw-business-2", connection_status: null }),
      candidate({ business_id: "raw-business-3", assigned_account_count: 0 }),
    ]);

    expect(summary.eligible).toHaveLength(1);
    expect(summary.skippedCandidates).toBe(2);
    expect(summary.skippedCandidatesByReason.no_current_meta_connection).toBe(1);
    expect(summary.skippedCandidatesByReason.no_accounts_assigned).toBe(1);
  });

  it("keeps internal segment coverage separate from quick-filter coverage", () => {
    const coverage = createEmptyCoverageSummary();

    recordCoverage({
      coverage,
      internalSegment: "contextual_only",
      quickFilter: "needs_truth",
      userFacingSegment: "Not eligible for evaluation",
      oldRuleSegment: "watch",
      baselineReliability: "strong",
      pushReadiness: "blocked_from_push",
    });

    expect(coverage.internalSegments).toEqual({ contextual_only: 1 });
    expect(coverage.quickFilters).toEqual({ needs_truth: 1 });
    expect(coverage.userFacingSegments).toEqual({ "Not eligible for evaluation": 1 });
    expect(coverage.oldRuleSegments).toEqual({ watch: 1 });
    expect(coverage.baselineReliability).toEqual({ strong: 1 });
    expect(coverage.pushReadiness).toEqual({ blocked_from_push: 1 });
  });

  it("classifies missing decryption key as runtime mismatch", async () => {
    const result = await assessRuntimeTokenReadability({
      candidates: [candidate({ has_encrypted_access_token: true })],
      hasTokenKey: false,
    });

    expect(result.status).toBe("missing_key");
    expect(result.sampledCandidates).toBe(1);
    expect(result.unreadableCandidates).toBe(1);
    expect(buildRuntimeTokenReadabilityBlocker(result.status)).toContain("missing");
    expect(
      hasIntegrationTokenDecryptionKey({
        INTEGRATION_TOKEN_ENCRYPTION_KEY: "set",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(hasIntegrationTokenDecryptionKey({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("classifies wrong or unreadable decryption key as runtime mismatch", async () => {
    const result = await assessRuntimeTokenReadability({
      candidates: [candidate({ business_id: "encrypted-business", has_encrypted_access_token: true })],
      hasTokenKey: true,
      readIntegration: async () => {
        throw new IntegrationSecretUnreadableError(
          "Encrypted integration secret could not be decrypted with the current runtime key.",
        );
      },
    });

    expect(result.status).toBe("unreadable_key");
    expect(result.readableCandidates).toBe(0);
    expect(result.unreadableCandidates).toBe(1);
    expect(
      isIntegrationCredentialReadabilityError(
        new IntegrationSecretUnreadableError(
          "Encrypted integration secret could not be decrypted with the current runtime key.",
        ),
      ),
    ).toBe(true);
    expect(
      classifyRuntimeTokenReadabilityError(
        new IntegrationSecretUnreadableError(
          "Encrypted integration secret could not be decrypted with the current runtime key.",
        ),
      ),
    ).toBe("unreadable_key");
    expect(buildRuntimeTokenReadabilityBlocker(result.status)).toContain("environment mismatch");
    expect(
      shouldReportNoLiveReadableBusinesses({
        runtimeTokenReadabilityStatus: result.status,
        runtimeEligibleCandidateCount: 0,
      }),
    ).toBe(false);
  });

  it("classifies readable runtime env when encrypted credentials can be read", async () => {
    const result = await assessRuntimeTokenReadability({
      candidates: [candidate({ business_id: "encrypted-business", has_encrypted_access_token: true })],
      hasTokenKey: true,
      readIntegration: async () =>
        ({
          access_token: "redacted",
          business_id: "encrypted-business",
          provider: "meta",
          status: "connected",
        } as never),
    });

    expect(result.status).toBe("readable");
    expect(result.readableCandidates).toBe(1);
    expect(buildRuntimeTokenReadabilityBlocker(result.status)).toBeNull();
  });

  it("does not conclude zero live businesses when runtime reads fail with a missing key error", async () => {
    const result = await assessRuntimeTokenReadability({
      candidates: [candidate({ business_id: "encrypted-business", has_encrypted_access_token: true })],
      hasTokenKey: true,
      readIntegration: async () => {
        throw new IntegrationSecretKeyRequiredError(
          "INTEGRATION_TOKEN_ENCRYPTION_KEY is required to decrypt integration secrets.",
        );
      },
    });

    expect(result.status).toBe("missing_key");
    expect(
      classifyRuntimeTokenReadabilityError(
        new IntegrationSecretKeyRequiredError(
          "INTEGRATION_TOKEN_ENCRYPTION_KEY is required to decrypt integration secrets.",
        ),
      ),
    ).toBe("missing_key");
    expect(
      shouldReportNoLiveReadableBusinesses({
        runtimeTokenReadabilityStatus: result.status,
        runtimeEligibleCandidateCount: 0,
      }),
    ).toBe(false);
  });

  it("classifies checkpointed Meta accounts as runtime token skips", () => {
    expect(
      classifyRuntimeCandidateSkip({
        payloadStatus: "no_data",
        tableRowCount: 0,
        accountProbes: [
          {
            ok: false,
            status: 400,
            errorCode: 190,
            errorSubcode: 459,
            rows: 0,
            spendBearingRows: 0,
          },
        ],
      }),
    ).toBe("meta_token_checkpointed");
  });

  it("classifies healthy zero-row reads as no current creative activity", () => {
    expect(
      classifyRuntimeCandidateSkip({
        payloadStatus: "no_data",
        tableRowCount: 0,
        accountProbes: [
          {
            ok: true,
            status: 200,
            errorCode: null,
            errorSubcode: null,
            rows: 0,
            spendBearingRows: 0,
          },
        ],
      }),
    ).toBe("no_current_creative_activity");
  });

  it("keeps runtime skip totals equal to classified reasons", () => {
    expect(
      countRuntimeSkippedCandidates({
        no_current_meta_connection: 0,
        meta_connection_not_connected: 0,
        no_access_token: 0,
        no_accounts_assigned: 0,
        meta_token_checkpointed: 1,
        provider_read_failure: 2,
        no_current_creative_activity: 3,
      }),
    ).toBe(6);
    expect(
      shouldReportNoLiveReadableBusinesses({
        runtimeTokenReadabilityStatus: "readable",
        runtimeEligibleCandidateCount: 0,
      }),
    ).toBe(true);
  });
});
