import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySession } from "./lib/auth";

/** Gates every page when AUTH_ENABLED=true; a no-op when the app is public. */
export async function middleware(req: NextRequest) {
  const enabled = (process.env.AUTH_ENABLED ?? "").toLowerCase();
  if (!(enabled === "1" || enabled === "true" || enabled === "yes")) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const user = await verifySession(
    req.cookies.get(SESSION_COOKIE)?.value,
    process.env.APP_SECRET ?? "",
  );
  if (user) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
