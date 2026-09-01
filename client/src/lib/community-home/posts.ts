import type { CommunityHomeVisibility } from "./visibility";

/**
 * Client-only Home posts. Durable for the tab via localStorage; never a row in
 * Postgres. Merging this PR does not restart pqp-api.
 */

export type CommunityHomeMedia = {
  kind: "image" | "file";
  name: string;
  sizeLabel: string;
  /** When true, the UI draws a patterned placeholder instead of a real file. */
  mock: true;
};

export type CommunityHomePost = {
  id: string;
  serverId: string;
  authorName: string;
  /** Display-only role chip: owner / vip / member. */
  authorBadge: "owner" | "vip" | "member";
  body: string;
  /** Free teaser shown above a locked members-only body/media. */
  teaser: string | null;
  createdAt: string;
  visibility: CommunityHomeVisibility;
  media: CommunityHomeMedia | null;
  /** Prefer joining a voice channel whose name matches (case-insensitive). */
  voiceChannelName: string | null;
  commentCount: number;
  featured: boolean;
};

export type CommunityHomeComposeInput = {
  body: string;
  visibility: CommunityHomeVisibility;
  teaser?: string | null;
  voiceChannelName?: string | null;
  mediaName?: string | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem"> | null;

const storageKey = (serverId: string) => `pqp:community-home-posts:${serverId}`;

function browserStorage(): StorageLike {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPost(value: unknown): value is CommunityHomePost {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as CommunityHomePost;
  return (
    typeof row.id === "string" &&
    typeof row.serverId === "string" &&
    typeof row.body === "string" &&
    (row.visibility === "free" || row.visibility === "members")
  );
}

/** Seed posts shaped like the HTML mocks (PT-BR copy, voice CTA, VIP lock). */
export function seedCommunityHomePosts(serverId: string): CommunityHomePost[] {
  const now = Date.now();
  return [
    {
      id: `seed-free-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      body: "Sessão 12. o porão. O mapa fica aqui em cima, não some no scroll do #avisos. Quem chegou, entra na call.",
      teaser: null,
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      visibility: "free",
      media: {
        kind: "image",
        name: "mapa-porao.png",
        sizeLabel: "1.8 MiB",
        mock: true,
      },
      voiceChannelName: null,
      commentCount: 3,
      featured: true,
    },
    {
      id: `seed-file-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      body: "ficha-rev3.pdf. Dentro do limite de 10 MiB. Imprimam antes da mesa.",
      teaser: null,
      createdAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
      visibility: "free",
      media: {
        kind: "file",
        name: "ficha-rev3.pdf",
        sizeLabel: "420 KiB",
        mock: true,
      },
      voiceChannelName: null,
      commentCount: 0,
      featured: false,
    },
    {
      id: `seed-vip-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      body: "Recorte da sessão 11. O teaser é livre; o clip fica no inner.",
      teaser: "Teaser livre. O .webm completo é só pra quem tem VIP (inner).",
      createdAt: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
      visibility: "members",
      media: {
        kind: "image",
        name: "sessao-11-clip.webm",
        sizeLabel: "6.2 MiB",
        mock: true,
      },
      voiceChannelName: null,
      commentCount: 1,
      featured: false,
    },
  ];
}

export function loadCommunityHomePosts(
  serverId: string,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  if (!storage) {
    return seedCommunityHomePosts(serverId);
  }
  try {
    const raw = storage.getItem(storageKey(serverId));
    if (!raw) {
      const seeded = seedCommunityHomePosts(serverId);
      storage.setItem(storageKey(serverId), JSON.stringify(seeded));
      return seeded;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return seedCommunityHomePosts(serverId);
    }
    const posts = parsed.filter(isPost).map((post) => ({
      ...post,
      serverId,
    }));
    return posts.length > 0 ? posts : seedCommunityHomePosts(serverId);
  } catch {
    return seedCommunityHomePosts(serverId);
  }
}

export function saveCommunityHomePosts(
  serverId: string,
  posts: CommunityHomePost[],
  storage: StorageLike = browserStorage(),
): void {
  try {
    storage?.setItem(storageKey(serverId), JSON.stringify(posts));
  } catch {
    // Compose still updates React state for the session.
  }
}

export function createCommunityHomePost(
  serverId: string,
  authorName: string,
  input: CommunityHomeComposeInput,
): CommunityHomePost {
  const body = input.body.trim();
  const mediaName = input.mediaName?.trim() || null;
  return {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    serverId,
    authorName: authorName.trim() || "você",
    authorBadge: "owner",
    body,
    teaser: input.visibility === "members" ? input.teaser?.trim() || null : null,
    createdAt: new Date().toISOString(),
    visibility: input.visibility,
    media: mediaName
      ? {
          kind: mediaName.toLowerCase().endsWith(".pdf") ? "file" : "image",
          name: mediaName,
          sizeLabel: "mock",
          mock: true,
        }
      : null,
    voiceChannelName: input.voiceChannelName?.trim() || null,
    commentCount: 0,
    featured: false,
  };
}

export function prependCommunityHomePost(
  serverId: string,
  post: CommunityHomePost,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const next = [post, ...loadCommunityHomePosts(serverId, storage)];
  saveCommunityHomePosts(serverId, next, storage);
  return next;
}

/** Prefer an explicit voice name on the post, else the first voice channel. */
export function resolveHomeVoiceChannelId(
  channels: readonly { id: string; name: string; type: string }[],
  preferredName: string | null,
): string | null {
  const voice = channels.filter((c) => c.type === "voice");
  if (voice.length === 0) {
    return null;
  }
  if (preferredName) {
    const needle = preferredName.trim().toLowerCase();
    const named = voice.find((c) => c.name.toLowerCase() === needle);
    if (named) {
      return named.id;
    }
  }
  return voice[0]?.id ?? null;
}
