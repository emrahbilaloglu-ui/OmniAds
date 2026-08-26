import { NextResponse } from "next/server";

import { DEV_PREVIEW_SHARE_MESSAGES } from "@/app/dev-preview-share/fixture";
import type { SharedMessage } from "@/components/creatives/shareCreativeTypes";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

let messages: SharedMessage[] = DEV_PREVIEW_SHARE_MESSAGES.map((message) => ({ ...message }));

function unavailable() {
  return NextResponse.json(
    { error: "not_found", message: "Preview route is unavailable." },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return unavailable();
  }

  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { error: "empty_text", message: "The note is empty." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (text.length > 600) {
    return NextResponse.json(
      { error: "invalid_text", message: "Notes are limited to 600 characters." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const message: SharedMessage = {
    id: `preview-message-${Date.now()}-${messages.length + 1}`,
    who: "viewer",
    name: "Preview viewer",
    text,
    postedAt: new Date().toISOString(),
  };
  messages = [...messages, message].slice(-50);

  return NextResponse.json(
    { messages: messages.map((message) => ({ ...message })) },
    { headers: NO_STORE_HEADERS },
  );
}
