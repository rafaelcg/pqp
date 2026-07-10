import { createClerkClient, verifyToken } from "@clerk/backend";
import { upsertUser } from "../services/users.js";
import type { DbUser } from "../db.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export interface AuthUser {
  clerkId: string;
  displayName: string;
  avatarUrl: string | null;
}

export const DEV_AUTH_TOKEN = "dev-local-token";

export function isDevAuthBypassEnabled(): boolean {
  return process.env.DEV_AUTH_BYPASS === "true";
}

export async function resolveAuthUser(
  authorization: string | undefined,
): Promise<{ user: DbUser } | null> {
  if (isDevAuthBypassEnabled()) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;

    if (token === DEV_AUTH_TOKEN) {
      const user = await upsertUser({
        clerkId: "dev_local_user",
        displayName: "Dev User",
        avatarUrl: null,
      });
      return { user };
    }
  }

  const auth = await verifyAuthHeader(authorization);
  if (!auth) {
    return null;
  }

  const user = await upsertUser(auth);
  return { user };
}

export async function verifyAuthHeader(
  authorization: string | undefined,
): Promise<AuthUser | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);

  if (isDevAuthBypassEnabled() && token === DEV_AUTH_TOKEN) {
    return {
      clerkId: "dev_local_user",
      displayName: "Dev User",
      avatarUrl: null,
    };
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    const clerkId = payload.sub;
    if (!clerkId) {
      return null;
    }

    const user = await clerk.users.getUser(clerkId);
    const displayName =
      user.fullName ??
      user.username ??
      user.primaryEmailAddress?.emailAddress ??
      "User";
    const avatarUrl = user.imageUrl ?? null;

    return { clerkId, displayName, avatarUrl };
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[auth] Token verification failed:", error);
    }
    return null;
  }
}
