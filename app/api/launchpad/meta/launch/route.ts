import { NextRequest } from "next/server";
import { handleMetaLaunchAction } from "@/lib/launchpad/meta-launch-route-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleMetaLaunchAction(request);
}
