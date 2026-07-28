import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getOpenAI } from "@/lib/openai";

/**
 * GET /api/ai/test
 *
 * Verifies OpenAI connectivity and API key validity.
 *
 * Every call spends real OpenAI credit, so it is superadmin-only. It used to
 * have no identity check at all, which meant proxy.ts was the only thing in
 * front of it — and proxy.ts admits any request carrying a non-empty
 * `omniads_session` cookie, whatever the value. A stranger could therefore bill
 * the account by looping over this URL with a forged cookie.
 */
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin.error) return admin.error;

  try {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_tokens: 20,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });

    const content = response.choices[0]?.message?.content ?? "";

    return NextResponse.json({
      ok: true,
      message: "OpenAI connection successful",
      model: response.model,
      reply: content.trim(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, message, error: "openai_connection_failed" },
      { status: 500 },
    );
  }
}
