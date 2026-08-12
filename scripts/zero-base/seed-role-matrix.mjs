/**
 * WP-26 group 2 — deterministic fixtures for the authenticated role matrix.
 *
 * Seeds one workspace with a member at each role the product distinguishes,
 * plus the three negative cases the plan cares about and no role can express:
 *
 * - a **second tenant**, so a member of workspace A can be pointed at workspace
 *   B and must be refused rather than shown another tenant's data;
 * - a **non-active membership**, which is different from having none — the row
 *   exists and must still be refused. `memberships_status_check` allows only
 *   active, invited and pending, so the fixture uses `pending`: there is no
 *   "inactive" status in this schema;
 * - a user with **no membership at all**, which is the select-business case.
 *
 * Active business is deliberately not set: the matrix navigates explicit
 * `/c/<businessId>/…` URLs, so authorization is proven against the workspace in
 * the URL rather than against a session default that could mask a failure.
 *
 * Everything is derived from a fixed prefix so a re-run is idempotent and the
 * ids are stable across runs. Passwords are fixed test values; this script only
 * ever runs against an ephemeral local database.
 */
import bcrypt from "bcryptjs";

import { ensureCoreTables, getEnv } from "../seed-shared.mjs";
import { createSqlClient } from "../sql-client.mjs";

const PREFIX = "zbrm";
const PASSWORD = "zero-base-role-matrix-pw";

/**
 * The membership roles the database actually permits.
 *
 * `memberships_role_check` allows exactly admin, collaborator and guest. There
 * is no `reviewer` membership row: reviewer is a seeded demo *account* and demo
 * is a flag on the business, so both are separate mechanisms rather than a
 * fourth role. Seeding a "reviewer" membership would have invented an authority
 * level the product does not have.
 */
const ROLES = ["guest", "collaborator", "admin"];

function email(name) {
  return `${PREFIX}+${name}@zero-base.test`;
}

async function main() {
  const sql = createSqlClient(getEnv("DATABASE_URL"));
  try {
    await ensureCoreTables(sql);
    const hash = await bcrypt.hash(PASSWORD, 10);

    // Businesses require an owner, so the owner exists before either tenant.
    const [owner] = await sql`
      INSERT INTO users (name, email, password_hash)
      VALUES (${`${PREFIX} owner`}, ${email("owner")}, ${hash})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `;

    // Two tenants: the second exists only so a cross-tenant request has a real
    // id to aim at. A fabricated uuid would prove nothing about authorization.
    const [primary] = await sql`
      INSERT INTO businesses (name, owner_id, currency)
      VALUES (${`${PREFIX} primary`}, ${owner.id}, 'USD')
      RETURNING id
    `;
    const [other] = await sql`
      INSERT INTO businesses (name, owner_id, currency)
      VALUES (${`${PREFIX} other`}, ${owner.id}, 'USD')
      RETURNING id
    `;

    const users = {};
    for (const role of ROLES) {
      const [user] = await sql`
        INSERT INTO users (name, email, password_hash)
        VALUES (${`${PREFIX} ${role}`}, ${email(role)}, ${hash})
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id
      `;
      await sql`
        INSERT INTO memberships (user_id, business_id, role, status)
        VALUES (${user.id}, ${primary.id}, ${role}, 'active')
        ON CONFLICT (user_id, business_id)
        DO UPDATE SET role = EXCLUDED.role, status = 'active'
      `;
      users[role] = { id: user.id, email: email(role) };
    }

    // Non-active membership: the row exists, so this proves the check reads
    // status and not merely existence.
    const [inactive] = await sql`
      INSERT INTO users (name, email, password_hash)
      VALUES (${`${PREFIX} inactive`}, ${email("inactive")}, ${hash})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `;
    await sql`
      INSERT INTO memberships (user_id, business_id, role, status)
      VALUES (${inactive.id}, ${primary.id}, 'collaborator', 'pending')
      ON CONFLICT (user_id, business_id)
      DO UPDATE SET role = 'collaborator', status = 'pending'
    `;
    users.inactive = { id: inactive.id, email: email("inactive") };

    // No membership anywhere: the select-business case.
    const [orphan] = await sql`
      INSERT INTO users (name, email, password_hash)
      VALUES (${`${PREFIX} orphan`}, ${email("orphan")}, ${hash})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `;
    await sql`DELETE FROM memberships WHERE user_id = ${orphan.id}`;
    users.orphan = { id: orphan.id, email: email("orphan") };

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        password: PASSWORD,
        primaryBusinessId: primary.id,
        otherBusinessId: other.id,
        users,
      })}\n`,
    );
  } finally {
    await sql.end?.();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
