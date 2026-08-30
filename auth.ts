import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getOrCreateUser } from "@/lib/users";

declare module "next-auth" {
  interface Session {
    uid?: number;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.email) {
        token.uid = await getOrCreateUser(user.email, user.name ?? null);
      }
      return token;
    },
    session({ session, token }) {
      session.uid = typeof token.uid === "number" ? token.uid : undefined;
      return session;
    },
  },
});
