import { NextResponse } from "next/server";

import { createSession, safeEqual, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { user, password } = env.auth;
  const body = await req.json().catch(() => ({}));

  const ok =
    typeof body?.username === "string" &&
    typeof body?.password === "string" &&
    safeEqual(body.username, user) &&
    password.length > 0 &&
    safeEqual(body.password, password);

  if (!ok) {
    return NextResponse.json({ error: "Incorrect username or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(user, env.auth.secret), sessionCookieOptions);
  return res;
}
