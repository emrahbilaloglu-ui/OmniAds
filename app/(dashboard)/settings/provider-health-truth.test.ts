import { describe, expect, it } from "vitest";
import { projectProviderHealth } from "@/app/(dashboard)/settings/settings-support";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import type { ProviderDomainState } from "@/store/integrations-store";

function domainsWith(overrides: Partial<ProviderDomainState>) {
  const domains = buildDefaultProviderDomains();
  domains.google = {
    ...domains.google,
    ...overrides,
    connection: { ...domains.google.connection, ...(overrides.connection ?? {}) },
    discovery: { ...domains.google.discovery, ...(overrides.discovery ?? {}) },
    assignment: { ...domains.google.assignment, ...(overrides.assignment ?? {}) },
  } as ProviderDomainState;
  return domains;
}

describe("Settings and Integrations report one provider health truth", () => {
  it("agrees with the Integrations derivation for an expired connection", () => {
    const domains = domainsWith({ connection: { status: "expired" } as never });

    const settings = projectProviderHealth(domains).google;
    const integrations = deriveProviderViewState("google", domains.google);

    expect(settings.label).toBe(integrations.statusLabel);
    expect(settings.label).toBe("Action required");
  });

  it("does not report a revoked connection as healthy", () => {
    const domains = domainsWith({ connection: { status: "error" } as never });
    expect(projectProviderHealth(domains).google.label).not.toMatch(/healthy/i);
    expect(projectProviderHealth(domains).google.label).toBe("Action required");
  });

  it("agrees for a connected, fully assigned provider", () => {
    const domains = domainsWith({
      connection: { status: "connected", providerAccountId: "123-456-7890" } as never,
      discovery: { status: "ready", entities: [{ id: "123" }], refreshFailed: false } as never,
      assignment: { selectedIds: ["123"] } as never,
    });

    const settings = projectProviderHealth(domains).google;
    const integrations = deriveProviderViewState("google", domains.google);

    expect(settings.label).toBe(integrations.statusLabel);
    expect(settings.label).toBe("Connected");
  });

  it("agrees for a connected provider with nothing assigned yet", () => {
    const domains = domainsWith({
      connection: { status: "connected" } as never,
      discovery: { status: "ready", entities: [{ id: "123" }] } as never,
      assignment: { selectedIds: [] } as never,
    });

    const settings = projectProviderHealth(domains).google;
    const integrations = deriveProviderViewState("google", domains.google);
    expect(settings.label).toBe(integrations.statusLabel);
  });

  it("covers every provider it is asked about", () => {
    const health = projectProviderHealth(buildDefaultProviderDomains(), ["meta", "google"]);
    expect(Object.keys(health).sort()).toEqual(["google", "meta"]);
  });

  it("falls back to default domains rather than throwing when state is absent", () => {
    expect(() => projectProviderHealth(undefined)).not.toThrow();
    expect(projectProviderHealth(undefined).meta.label).toBe(
      deriveProviderViewState("meta", buildDefaultProviderDomains().meta).statusLabel,
    );
  });
});
