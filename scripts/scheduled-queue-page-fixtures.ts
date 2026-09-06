/** Real PostgreSQL fixtures for the scheduler's actual pending-page SQL.
 * Called inside the ephemeral decision/launch seam transaction. Temporary
 * tables shadow only that session's queue/intent reads and disappear at commit.
 */
import { readFileSync } from "node:fs";

type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export async function verifyScheduledQueuePageFixtures(query: Query): Promise<number> {
  const source = readFileSync("lib/meta/budget-automation-scheduled.ts", "utf8");
  const page = source.slice(source.indexOf("const pending = ("), source.indexOf("// An unread queue is unknown"));
  const sql = page.match(/`([\s\S]*?)`,\s*\[/)?.[1];
  if (!sql) throw new Error("Cannot locate the production scheduler pending-page query");

  await query(`CREATE TEMP TABLE meta_automation_proposals (
    id UUID, business_id UUID, provider_account_id TEXT, proposed_action TEXT,
    launch_intent_id UUID, scope_type TEXT, origin TEXT, rec_type TEXT,
    status TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ
  ) ON COMMIT DROP`);
  await query(`CREATE TEMP TABLE meta_launch_intents (
    id UUID, business_id UUID, activation_approval_json JSONB
  ) ON COMMIT DROP`);
  const business = "c9a10000-0000-4000-8000-0000000000b1";
  const otherBusiness = "c9a10000-0000-4000-8000-0000000000b2";
  const account = "act_queue_1";
  const id = (n: number) => `c9a10000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  await query(`INSERT INTO pg_temp.meta_launch_intents VALUES
    ($1, $4, '{"approvalId":"approved"}'), ($2, $4, NULL),
    ($3, $4, '{"revokedAt":"2026-09-06T10:00:00Z"}')`, [id(101), id(102), id(103), business]);
  const fixtures = [
    { n: 1, action: "resume", intent: null, scope: "campaign", origin: "engine_decision", rec: null },
    { n: 2, action: "resume", intent: id(101), scope: "campaign", origin: "operator_action", rec: null },
    { n: 3, action: "resume", intent: id(101), scope: "ad", origin: "operator_action", rec: null },
    { n: 4, action: "resume", intent: id(102), scope: "ad", origin: "operator_action", rec: null },
    { n: 5, action: "resume", intent: id(103), scope: "ad", origin: "operator_action", rec: null },
    { n: 6, action: "budget", intent: null, scope: "campaign", origin: "engine_decision", rec: null },
    { n: 7, action: "pause", intent: null, scope: "ad", origin: "engine_decision", rec: "native_ad_cut" },
    { n: 8, action: "pause", intent: null, scope: "campaign", origin: "engine_decision", rec: "native_ad_cut" },
    { n: 9, action: "pause", intent: null, scope: "ad", origin: "engine_decision", rec: null },
    { n: 10, action: "pause", intent: null, scope: "ad", origin: "operator_action", rec: "native_ad_cut" },
  ];
  for (const row of fixtures) {
    await query(`INSERT INTO pg_temp.meta_automation_proposals VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + interval '1 day',
      '2026-01-01'::timestamptz + $9::int * interval '1 second'
    )`, [id(row.n), business, account, row.action, row.intent, row.scope, row.origin, row.rec, row.n]);
  }
  await query(`INSERT INTO pg_temp.meta_automation_proposals
    SELECT $1, $2, provider_account_id, proposed_action, launch_intent_id,
           scope_type, origin, rec_type, status, expires_at, created_at
      FROM pg_temp.meta_automation_proposals WHERE id = $3`, [id(11), otherBusiness, id(7)]);
  await query(`INSERT INTO pg_temp.meta_automation_proposals
    SELECT $1, business_id, 'act_queue_2', proposed_action, launch_intent_id,
           scope_type, origin, rec_type, status, expires_at, created_at
      FROM pg_temp.meta_automation_proposals WHERE id = $2`, [id(12), id(7)]);

  let cases = 0;
  async function assertPage(input: {
    label: string; pauseAuto: boolean; creativeAuto: boolean; activationGate?: boolean;
    blockNative?: boolean; actions?: string[]; limit?: number; businessId?: string; expected: number[];
  }) {
    const actual = (await query(sql!, [
      input.businessId ?? business, account, input.limit ?? 100, input.actions ?? ["resume"],
      input.pauseAuto, input.creativeAuto && input.activationGate !== false, input.blockNative ?? false,
    ])).map((row) => row.id).sort();
    const expected = input.expected.map(id).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${input.label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    cases += 1;
  }
  await assertPage({ label: "pause auto / creative semi-auto leaves activations pending", pauseAuto: true, creativeAuto: false, expected: [1] });
  await assertPage({ label: "creative auto / pause semi-auto leaves ordinary resumes pending", pauseAuto: false, creativeAuto: true, expected: [2, 3] });
  await assertPage({ label: "both families auto admit both resume forms", pauseAuto: true, creativeAuto: true, expected: [1, 2, 3] });
  await assertPage({ label: "neither family auto admits no resume", pauseAuto: false, creativeAuto: false, expected: [] });
  await assertPage({ label: "closed activation gate preserves ordinary auto resumes", pauseAuto: true, creativeAuto: true, activationGate: false, expected: [1] });
  await assertPage({ label: "closed activation gate with creative-only auto admits nothing", pauseAuto: false, creativeAuto: true, activationGate: false, expected: [] });
  await assertPage({ label: "older ordinary resumes cannot crowd out an auto activation", pauseAuto: false, creativeAuto: true, limit: 1, expected: [2] });
  await query("UPDATE pg_temp.meta_automation_proposals SET created_at = '2025-01-01' WHERE id = $1", [id(2)]);
  await assertPage({ label: "older activation cannot crowd out an auto ordinary resume", pauseAuto: true, creativeAuto: false, limit: 1, expected: [1] });
  await assertPage({ label: "native refresh failure excludes only the exact native pause family", pauseAuto: true, creativeAuto: false, blockNative: true, actions: ["pause", "budget"], expected: [6, 8, 9, 10] });
  await assertPage({ label: "healthy native refresh retains its automatic pause", pauseAuto: true, creativeAuto: false, actions: ["pause", "budget"], expected: [6, 7, 8, 9, 10] });
  await assertPage({ label: "unaffected business still receives its native pause", businessId: otherBusiness, pauseAuto: true, creativeAuto: false, actions: ["pause"], expected: [11] });
  await assertPage({ label: "global native failure excludes native rows in another business", businessId: otherBusiness, pauseAuto: true, creativeAuto: false, blockNative: true, actions: ["pause"], expected: [] });
  const pending = await query("SELECT count(*)::int AS rows FROM pg_temp.meta_automation_proposals WHERE status = 'pending'");
  if (pending[0]?.rows !== 12) throw new Error("Selector changed a pending proposal");
  return cases;
}
