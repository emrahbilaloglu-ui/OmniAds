import type { PoolClient } from "pg";
import { archiveDigest } from "./business-archive-configuration";
import { need,UUID,SHA } from "../scripts/native-storage-batch/common";
export interface OwnedColdSession {contract:"native-cold-temporary-session.v1";sessionId:string;userId:string;
  businessId:string;tokenSha256:string}
export function validateOwnedColdSession(s:OwnedColdSession,businessId:string){
  need(s?.contract==="native-cold-temporary-session.v1"&&UUID.test(s.sessionId)&&UUID.test(s.userId)&&
    UUID.test(businessId)&&s.businessId===businessId&&SHA.test(s.tokenSha256),"EXACT_OWNED_COLD_SESSION");return s;
}
export async function insertOwnedColdSession(db:Pick<PoolClient,"query">,s:OwnedColdSession,token:string){
  validateOwnedColdSession(s,s.businessId);need(/^[a-f0-9]{64}$/.test(token)&&archiveDigest(token)===s.tokenSha256,"EXACT_EPHEMERAL_TOKEN");
  const r=await db.query(`INSERT INTO sessions(id,user_id,active_business_id,token_hash,expires_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::text,clock_timestamp()+interval '10 minutes')
    ON CONFLICT DO NOTHING RETURNING id`,[s.sessionId,s.userId,s.businessId,s.tokenSha256]);
  need(r.rowCount===1,"NEW_EPHEMERAL_SESSION_REQUIRED");
}
/** The private journal precedes INSERT. A restart deletes only its own exact
 * id/user/token digest, including when the INSERT ack was lost or normal
 * session selection cleared/switched its active business. No
 * token bytes or unrelated user session can be removed or emitted. */
export async function cleanupOwnedColdSession(db:Pick<PoolClient,"query">,s:OwnedColdSession){
  validateOwnedColdSession(s,s.businessId);
  const values=[s.sessionId,s.userId,s.tokenSha256];
  await db.query(`DELETE FROM sessions WHERE id=$1::uuid AND user_id=$2::uuid AND token_hash=$3::text`,values);
  const r=await db.query(`SELECT 1 FROM sessions WHERE id=$1::uuid AND user_id=$2::uuid AND token_hash=$3::text`,values);
  need(r.rows.length===0,"OWNED_COLD_SESSION_SURVIVES");
  return {temporarySessionRemoved:true as const};
}
