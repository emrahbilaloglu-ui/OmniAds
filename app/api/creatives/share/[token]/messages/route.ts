import { NextRequest, NextResponse } from "next/server";
import { appendCreativeShareMessage } from "@/lib/creative-share-store";
import { normalizeCreativeShareToken } from "@/lib/creative-share-link";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

/**
 * Post one message to a share's public thread.
 *
 * DELIBERATELY UNAUTHENTICATED. The public share page has no sign-in, and
 * "Notes & questions" is answerable by anyone holding the link — the same
 * reach the page itself already has. This endpoint can do exactly one thing:
 * append a short text message to a snapshot's own thread if that snapshot is
 * still live. It cannot read or touch anything else, and every response is the
 * same neutral shape whether the token is dead or was never valid, matching
 * the rest of the public share surface.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const token = normalizeCreativeShareToken((await context.params).token);
  if (!token) {
    return NextResponse.json(
      { error: "not_found", message: "Share link not found, revoked, or expired." },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json(
      { error: "empty_text", message: "The note is empty." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const result = await appendCreativeShareMessage({ token, text });
  if (!result.ok) {
    if (result.reason === "invalid_text") {
      return NextResponse.json(
        { error: "invalid_text", message: "Notes are limited to 600 characters." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (result.reason === "limit_reached") {
      return NextResponse.json(
        {
          error: "limit_reached",
          message: "This snapshot's thread is full. Ask the sender for a new link.",
        },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "not_found", message: "Share link not found, revoked, or expired." },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json({ messages: result.messages }, { headers: NO_STORE_HEADERS });
}
