import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  if (req.auth?.uid != null || process.env.AUTH_DEV_USER) return;
  if (req.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const signIn = new URL("/api/auth/signin", req.nextUrl);
  signIn.searchParams.set("callbackUrl", req.nextUrl.href);
  return NextResponse.redirect(signIn);
});

export const config = {
  matcher: ["/((?!api/auth|_next|favicon\\.ico|.*\\.svg$).*)"],
};
