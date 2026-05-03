import { NextResponse } from "next/server";
import { getCurrentRuntimeBuildId } from "@/lib/build-runtime";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      buildId: getCurrentRuntimeBuildId(),
      nodeEnv: process.env.NODE_ENV ?? "unknown",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
