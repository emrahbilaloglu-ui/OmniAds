import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const { DEMO_BUSINESS_ID } = await import("@/lib/demo-business-support");
const { readLaunchpadWriteAuthority, rejectIfLaunchpadDemoWrite } = await import(
  "./demo-write-authority"
);

const LIVE_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("Launchpad demo write authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // LAW (docs/creative-decision-center/INVARIANTS.md): "Demo businesses have
  // zero Meta write authority even if a presentation defect supplies an
  // action." This is the server-side statement of that rule for Launchpad. It
  // exists because the reviewer guard does not cover it: `/api/auth/demo-login`
  // opens a session as an ADMIN of the demo business under a non-reviewer
  // email, so a demo session cleared both the role check and the reviewer check
  // on every Launchpad write route.
  it("refuses the well-known demo business without reading the table", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(readLaunchpadWriteAuthority(DEMO_BUSINESS_ID)).resolves.toBe(
      "demo",
    );
    expect(sql).not.toHaveBeenCalled();
  });

  it("refuses a business the table flags as demo", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: true }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(readLaunchpadWriteAuthority(LIVE_BUSINESS_ID)).resolves.toBe(
      "demo",
    );
  });

  it("allows a business the table proves is live", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: false }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(readLaunchpadWriteAuthority(LIVE_BUSINESS_ID)).resolves.toBe(
      "live",
    );
  });

  // LAW: missing or unreadable data must never become success. `isDemoBusiness`
  // in lib/business-mode.server.ts swallows its own failure and answers "not the
  // well-known demo id" — which reads a database outage as "live". Survivable
  // for a read-only presentation; wrong direction for a provider write. Here an
  // unreadable flag is `unverified` and holds the write.
  it("holds the write when the demo flag cannot be read", async () => {
    const sql = vi.fn(async () => {
      throw new Error("db down");
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(readLaunchpadWriteAuthority(LIVE_BUSINESS_ID)).resolves.toBe(
      "unverified",
    );
  });

  // The caller has already been authorized against a membership on this
  // business, so "no row" is a broken read, not proof of a live workspace.
  it("holds the write when the business row is absent", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(readLaunchpadWriteAuthority(LIVE_BUSINESS_ID)).resolves.toBe(
      "unverified",
    );
  });

  it("answers 403 demo_business_read_only for a demo workspace", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: true }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfLaunchpadDemoWrite(
      LIVE_BUSINESS_ID,
      "launchpad_launch",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.error.code).toBe("demo_business_read_only");
    expect(body.error.action).toBe("launchpad_launch");
  });

  it("answers 503 demo_status_unverified rather than letting the write through", async () => {
    const sql = vi.fn(async () => {
      throw new Error("db down");
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfLaunchpadDemoWrite(
      LIVE_BUSINESS_ID,
      "launchpad_launch",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const body = await response!.json();
    expect(body.error.code).toBe("demo_status_unverified");
  });

  it("returns null only for a proven live workspace", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: false }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      rejectIfLaunchpadDemoWrite(LIVE_BUSINESS_ID, "launchpad_launch"),
    ).resolves.toBeNull();
  });
});
