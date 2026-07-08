import { NextResponse } from "next/server";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";

export async function rejectIfMetaWritesBlocked(input: {
  businessId: string;
}): Promise<NextResponse | null> {
  const block = await getMetaWriteBlockState({ businessId: input.businessId });
  if (!block.blocked) return null;
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "kill_switch_engaged",
        message: block.message ?? "Meta writes are disabled by kill switch.",
        reason: block.reason,
      },
    },
    { status: 503 },
  );
}
