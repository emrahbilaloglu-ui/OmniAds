import { createHash, randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

const RESET_TOKEN_TTL_MINUTES = 30;

function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Mint a single-use password-reset token for a user. The raw token is returned once (to
 * embed in the reset link); only its sha256 hash is persisted, so a DB read never reveals
 * a usable token. Any prior unused token for the user is invalidated first.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  const sql = getDb();
  const raw = randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(raw);
  await sql`DELETE FROM password_reset_tokens WHERE user_id = ${userId} AND used_at IS NULL`;
  await sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (
      ${userId},
      ${tokenHash},
      NOW() + (${RESET_TOKEN_TTL_MINUTES} || ' minutes')::interval
    )
  `;
  return raw;
}

export interface ConsumePasswordResetResult {
  ok: boolean;
}

/**
 * Validate a reset token and, if it is unused and unexpired, set the user's new password
 * and revoke all their sessions. Returns { ok: false } for any invalid/expired/used token
 * (the route must respond generically to avoid leaking whether a token or user exists).
 */
export async function consumePasswordResetToken(
  rawToken: string,
  newPassword: string,
): Promise<ConsumePasswordResetResult> {
  const sql = getDb();
  const tokenHash = hashResetToken(rawToken);
  const rows = (await sql`
    SELECT id, user_id
    FROM password_reset_tokens
    WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > NOW()
    LIMIT 1
  `) as Array<{ id: string; user_id: string }>;
  if (rows.length === 0) return { ok: false };
  const { id, user_id } = rows[0];
  const passwordHash = await hashPassword(newPassword);
  await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${user_id}`;
  await sql`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ${id}`;
  await sql`DELETE FROM sessions WHERE user_id = ${user_id}`;
  return { ok: true };
}
