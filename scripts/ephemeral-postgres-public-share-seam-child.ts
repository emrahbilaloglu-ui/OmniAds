// Child of ephemeral-postgres-migrations-check: proves the public creative
// share lifecycle against real storage.
//
// The claims here are claims about a transaction and a SQL predicate — that a
// rotation revokes the old token in the same breath as issuing the new one,
// and that every dead state resolves to the same public nothing. A mocked
// store returns whatever the test author wrote, so none of that is provable
// without a real server.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import {
  createCreativeShareSnapshot,
  getCreativeShareSnapshot,
  revokeCreativeShareSnapshot,
  rotateCreativeShareSnapshot,
} from "@/lib/creative-share-store";
import { toPublicShare, findLeakedIdentity } from "@/lib/zero-base/creative/public-share";

const LABEL = "public-share-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}
function expectTrue(value: boolean, label: string, detail?: string) {
  if (!value) fail(label, detail);
}
function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const USER_ID = "d0000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "d0000000-0000-4000-8000-0000000000b1";
const ACCOUNT = "act_public_seam";
const BUSINESS_NAME = "Acme Internal Workspace";
const CLIENT_EMAIL = "finance@acme-internal.example";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Q3 creatives",
    dateRange: "2026-07-01..2026-07-31",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    metrics: [],
    audience: "buyer" as const,
    includeNotes: false,
    // Workspace identity deliberately present in storage: the public mapper
    // must drop it, and this seam proves it does against a real round trip.
    businessName: BUSINESS_NAME,
    clientEmail: CLIENT_EMAIL,
    creatives: [
      {
        id: "cr-1",
        name: "Hero video",
        format: "video",
        previewState: "preview",
        isCatalog: false,
        previewUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        preview: {
          render_mode: "video",
          image_url: null,
          video_url: "https://cdn.example/hero.mp4",
          poster_url: "https://cdn.example/hero.jpg",
          source: "preview_url",
          is_catalog: false,
        },
        launchDate: "2026-07-01",
        tags: [],
        spend: 100,
        purchaseValue: 300,
        roas: 3,
        cpa: 10,
        ctrAll: 1.2,
        purchases: 10,
      },
    ],
    ...overrides,
  } as unknown as Parameters<typeof createCreativeShareSnapshot>[0];
}

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'share@example.com', 'Seed', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency, timezone)
     VALUES ($1::uuid, 'Share Seam', $2::uuid, 'USD', 'UTC') ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );
}

const attribution = { businessId: BUSINESS_ID, providerAccountId: ACCOUNT, createdBy: USER_ID };

async function main() {
  await seed();

  // ------------------------------------------------------------ round trip
  const created = await createCreativeShareSnapshot(payload(), attribution);
  expectTrue(Boolean(created.token), "a share is created with a token");

  const read = await getCreativeShareSnapshot(created.token);
  expectTrue(read !== null, "the live token resolves");

  // ---------------------------------------------------------- sanitization
  const publicView = toPublicShare(read!);
  const leaked = findLeakedIdentity(publicView, [
    BUSINESS_ID,
    ACCOUNT,
    BUSINESS_NAME,
    CLIENT_EMAIL,
    USER_ID,
  ]);
  expectEqual(leaked, [], "no workspace identity survives into the public view");
  expectEqual(publicView.audience, "buyer", "buyer audience survives");
  expectTrue(
    Boolean(publicView.financialWarning),
    "a buyer share carries the financial limitation disclosure",
  );
  expectEqual(publicView.captionsSupported, false, "no caption support is claimed");
  expectEqual(publicView.creatives.length, 1, "the creative is published");
  expectEqual(publicView.creatives[0]!.media?.kind, "video", "a served video maps to video media");
  expectEqual(
    publicView.creatives[0]!.media?.captionsUrl ?? null,
    null,
    "no captions url is invented, because the contract serves none",
  );

  // ---------------------------------------------------------- rotation
  const rotated = await rotateCreativeShareSnapshot({
    token: created.token,
    businessId: BUSINESS_ID,
    revokedBy: USER_ID,
  });
  expectTrue(rotated !== null, "rotation succeeds on a live token");
  expectTrue(rotated!.token !== created.token, "rotation issues a different token");

  // The whole point: the old link is dead through the real read path.
  const oldAfterRotate = await getCreativeShareSnapshot(created.token);
  expectEqual(oldAfterRotate, null, "the rotated-away token no longer resolves");

  const newAfterRotate = await getCreativeShareSnapshot(rotated!.token);
  expectTrue(newAfterRotate !== null, "the newly issued token resolves");
  expectEqual(
    toPublicShare(newAfterRotate!).title,
    "Q3 creatives",
    "the rotated share carries the same content",
  );

  // --------------------------------------------- every dead state is one state
  const revokable = await createCreativeShareSnapshot(payload(), attribution);
  await revokeCreativeShareSnapshot({
    token: revokable.token,
    businessId: BUSINESS_ID,
    revokedBy: USER_ID,
  });

  const expired = await createCreativeShareSnapshot(
    payload({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    attribution,
  );
  await getDb().query(
    `UPDATE creative_share_snapshots SET expires_at = NOW() - INTERVAL '1 day' WHERE token = $1`,
    [expired.token],
  );

  const dead = {
    revoked: await getCreativeShareSnapshot(revokable.token),
    expired: await getCreativeShareSnapshot(expired.token),
    rotatedAway: await getCreativeShareSnapshot(created.token),
    malformed: await getCreativeShareSnapshot("not-a-real-token-$$$"),
    neverExisted: await getCreativeShareSnapshot("0".repeat(32)),
  };
  for (const [name, value] of Object.entries(dead)) {
    expectEqual(value, null, `${name} resolves to the same nothing`);
  }

  console.log(
    `[${LABEL}] PASS: a share round-trips through the real store; the public view leaks no ` +
      "business id, provider account, workspace name, contact address or actor id; a buyer share " +
      "keeps its financial disclosure and claims no caption support; rotation issues a new token, " +
      "kills the old one through the real read path, and preserves content; and revoked, expired, " +
      "rotated-away, malformed and never-existing tokens are all indistinguishably absent.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
