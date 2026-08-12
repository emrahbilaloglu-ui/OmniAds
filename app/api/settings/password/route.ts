import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, hashPassword, verifyPassword } from "@/lib/auth";
import { getUserById, updateUserPassword } from "@/lib/account-store";

interface PasswordBody {
  currentPassword?: string;
  nextPassword?: string;
}

export async function POST(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "auth_error", message: "Authentication required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as PasswordBody | null;
  const currentPassword = body?.currentPassword ?? "";
  const nextPassword = body?.nextPassword ?? "";
  if (!currentPassword || !nextPassword) {
    return NextResponse.json({ error: "invalid_payload", message: "Current and new password are required." }, { status: 400 });
  }
  if (nextPassword.length < 12) {
    return NextResponse.json({ error: "weak_password", message: "New password must be at least 12 characters." }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    return NextResponse.json({ error: "invalid_credentials", message: "Current password is incorrect." }, { status: 401 });
  }

  const passwordHash = await hashPassword(nextPassword);
  await updateUserPassword({ userId: user.id, passwordHash });
  return NextResponse.json({ status: "ok" });
}
