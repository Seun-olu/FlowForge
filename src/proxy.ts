import { NextResponse, type NextRequest } from "next/server";

/** Cheap gate: no session cookie → login. The signature is verified server-side in getUser(). */
export function proxy(req: NextRequest) {
  if (!req.cookies.has("ff_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!login|signup|api/worker|_next|favicon.ico).*)"] };
