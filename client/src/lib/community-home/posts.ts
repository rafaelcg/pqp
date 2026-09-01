import type { CommunityHomeMedia } from "./media";
import {
  COMMUNITY_HOME_MAX_BYTES,
  formatHomeBytes,
  parseYoutubeVideoId,
} from "./media";
import type { CommunityHomeVisibility } from "./visibility";

/**
 * Client-only Home posts. Durable for the tab via localStorage; never a row in
 * Postgres. Merging this PR does not restart pqp-api.
 *
 * Storage key stays `pqp:community-home-posts:{serverId}`. Version bumps force
 * a reseed so older mock shapes (call CTAs, count-only comments) do not linger.
 */

export type { CommunityHomeMedia } from "./media";

export type CommunityHomePostStatus = "draft" | "published";

export type CommunityHomeAuthorBadge = "owner" | "vip" | "member";

export type CommunityHomeComment = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type CommunityHomePost = {
  id: string;
  serverId: string;
  authorName: string;
  /** Display-only role chip on the card. VIP cargo cannot publish. */
  authorBadge: CommunityHomeAuthorBadge;
  /** Optional title (locked cards show title + teaser). */
  title: string | null;
  body: string;
  /** Free teaser shown above a locked members-only body/media. */
  teaser: string | null;
  createdAt: string;
  updatedAt: string;
  visibility: CommunityHomeVisibility;
  media: CommunityHomeMedia | null;
  status: CommunityHomePostStatus;
  commentsEnabled: boolean;
  comments: CommunityHomeComment[];
  featured: boolean;
};

export type CommunityHomeComposeInput = {
  title?: string | null;
  body: string;
  visibility: CommunityHomeVisibility;
  teaser?: string | null;
  media?: CommunityHomeMedia | null;
  status?: CommunityHomePostStatus;
  commentsEnabled?: boolean;
  authorBadge?: CommunityHomeAuthorBadge;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

/** Bump when the fixture shape changes so localStorage reseeds. */
export const COMMUNITY_HOME_POSTS_VERSION = 2;

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

function isComment(value: unknown): value is CommunityHomeComment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as CommunityHomeComment;
  return (
    typeof row.id === "string" &&
    typeof row.authorName === "string" &&
    typeof row.body === "string" &&
    typeof row.createdAt === "string"
  );
}

function isMedia(value: unknown): value is CommunityHomeMedia | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as CommunityHomeMedia;
  return (
    row.kind === "image" ||
    row.kind === "video" ||
    row.kind === "youtube" ||
    row.kind === "file"
  );
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
    (row.visibility === "free" || row.visibility === "members") &&
    (row.status === "draft" || row.status === "published") &&
    isMedia(row.media ?? null) &&
    Array.isArray(row.comments)
  );
}

function normalizePost(
  post: CommunityHomePost,
  serverId: string,
): CommunityHomePost {
  return {
    ...post,
    serverId,
    title: post.title ?? null,
    teaser: post.teaser ?? null,
    updatedAt: post.updatedAt || post.createdAt,
    commentsEnabled: post.commentsEnabled !== false,
    comments: (post.comments ?? []).filter(isComment),
    featured: Boolean(post.featured),
    authorBadge:
      post.authorBadge === "owner" || post.authorBadge === "vip"
        ? post.authorBadge
        : "member",
  };
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Seed posts shaped like the Mesa da Tues mocks: durable media, free vs VIP,
 * no voice / "entrar na call" CTAs.
 */
export function seedCommunityHomePosts(serverId: string): CommunityHomePost[] {
  const now = Date.now();
  return [
    {
      id: `seed-mapa-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      title: "Sessão 12. o porão.",
      body: "hoje 21h a gente desce pro porão. eu já tô com o mapa na tela. quem chegar cedo pega lugar na mesa, o resto ouve.",
      teaser: null,
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      visibility: "free",
      media: {
        kind: "image",
        name: "mapa-porao.png",
        sizeLabel: "1.8 MiB",
        sizeBytes: Math.round(1.8 * 1024 * 1024),
        mock: true,
      },
      status: "published",
      commentsEnabled: true,
      comments: [
        {
          id: `seed-c1-${serverId}`,
          authorName: "Bia",
          body: "eu levo os dados",
          createdAt: new Date(now - 90 * 60 * 1000).toISOString(),
        },
        {
          id: `seed-c2-${serverId}`,
          authorName: "Nuno",
          body: "mapa ficou bom demais",
          createdAt: new Date(now - 80 * 60 * 1000).toISOString(),
        },
        {
          id: `seed-c3-${serverId}`,
          authorName: "Carol",
          body: "chego 20:40",
          createdAt: new Date(now - 70 * 60 * 1000).toISOString(),
        },
      ],
      featured: true,
    },
    {
      id: `seed-ficha-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      title: null,
      body: "ficha-rev3.pdf. Dentro do limite de 10 MiB. Imprimam antes da mesa.",
      teaser: null,
      createdAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
      visibility: "free",
      media: {
        kind: "file",
        name: "ficha-rev3.pdf",
        sizeLabel: "420 KiB",
        sizeBytes: 420 * 1024,
        mock: true,
      },
      status: "published",
      commentsEnabled: true,
      comments: [],
      featured: false,
    },
    {
      id: `seed-recorte-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      title: "recorte da sessão 11",
      body: "o corte que o Nuno pediu. teaser livre, o arquivo fica no inner.",
      teaser: "Teaser livre. O .webm completo é só pra quem tem VIP (inner).",
      createdAt: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
      visibility: "members",
      media: {
        kind: "video",
        name: "sessao-11-clip.webm",
        sizeLabel: "8.4 MiB",
        sizeBytes: Math.round(8.4 * 1024 * 1024),
        mock: true,
      },
      status: "published",
      commentsEnabled: true,
      comments: [
        {
          id: `seed-c4-${serverId}`,
          authorName: "Nuno",
          body: "esse corte sim",
          createdAt: new Date(now - 40 * 60 * 60 * 1000).toISOString(),
        },
      ],
      featured: false,
    },
    {
      id: `seed-yt-${serverId}`,
      serverId,
      authorName: "Tues",
      authorBadge: "owner",
      title: "Recap sessão 10",
      body: "recap no YouTube. quem perdeu a mesa, começa por aqui.",
      teaser: null,
      createdAt: new Date(now - 74 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 74 * 60 * 60 * 1000).toISOString(),
      visibility: "free",
      media: {
        kind: "youtube",
        name: "YouTube",
        sizeLabel: "embed",
        // Public sample; unlocked viewers get the iframe. Locked posts must
        // never put this URL in the free DOM — this seed is free.
        youtubeUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        mock: true,
      },
      status: "published",
      commentsEnabled: true,
      comments: [],
      featured: false,
    },
  ];
}

type StoredEnvelope = {
  version: number;
  posts: CommunityHomePost[];
};

function parseStored(raw: string, serverId: string): CommunityHomePost[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy v1 array — force reseed.
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const envelope = parsed as StoredEnvelope;
    if (envelope.version !== COMMUNITY_HOME_POSTS_VERSION) {
      return null;
    }
    if (!Array.isArray(envelope.posts)) {
      return null;
    }
    const posts = envelope.posts.filter(isPost).map((p) => normalizePost(p, serverId));
    return posts.length > 0 ? posts : null;
  } catch {
    return null;
  }
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
      saveCommunityHomePosts(serverId, seeded, storage);
      return seeded;
    }
    const posts = parseStored(raw, serverId);
    if (!posts) {
      const seeded = seedCommunityHomePosts(serverId);
      saveCommunityHomePosts(serverId, seeded, storage);
      return seeded;
    }
    return posts;
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
    const envelope: StoredEnvelope = {
      version: COMMUNITY_HOME_POSTS_VERSION,
      posts,
    };
    storage?.setItem(storageKey(serverId), JSON.stringify(envelope));
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
  const now = new Date().toISOString();
  const media = input.media ?? null;
  if (media?.kind === "youtube" && media.youtubeUrl) {
    if (!parseYoutubeVideoId(media.youtubeUrl)) {
      throw new Error("invalid_youtube");
    }
  }
  if (
    media &&
    (media.kind === "video" || media.kind === "file" || media.kind === "image") &&
    typeof media.sizeBytes === "number" &&
    media.sizeBytes > COMMUNITY_HOME_MAX_BYTES
  ) {
    throw new Error("over_limit");
  }
  return {
    id: newId("local"),
    serverId,
    authorName: authorName.trim() || "você",
    authorBadge: input.authorBadge ?? "member",
    title: input.title?.trim() || null,
    body,
    teaser: input.visibility === "members" ? input.teaser?.trim() || null : null,
    createdAt: now,
    updatedAt: now,
    visibility: input.visibility,
    media,
    status: input.status ?? "published",
    commentsEnabled: input.commentsEnabled !== false,
    comments: [],
    featured: false,
  };
}

export function upsertCommunityHomePost(
  serverId: string,
  post: CommunityHomePost,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const current = loadCommunityHomePosts(serverId, storage);
  const index = current.findIndex((row) => row.id === post.id);
  const next =
    index === -1
      ? [post, ...current]
      : current.map((row, i) => (i === index ? post : row));
  saveCommunityHomePosts(serverId, next, storage);
  return next;
}

export function prependCommunityHomePost(
  serverId: string,
  post: CommunityHomePost,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  return upsertCommunityHomePost(serverId, post, storage);
}

export function updateCommunityHomePost(
  serverId: string,
  postId: string,
  patch: Partial<CommunityHomePost>,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const current = loadCommunityHomePosts(serverId, storage);
  const next = current.map((row) =>
    row.id === postId
      ? {
          ...row,
          ...patch,
          id: row.id,
          serverId,
          updatedAt: new Date().toISOString(),
        }
      : row,
  );
  saveCommunityHomePosts(serverId, next, storage);
  return next;
}

export function deleteCommunityHomePost(
  serverId: string,
  postId: string,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const next = loadCommunityHomePosts(serverId, storage).filter(
    (row) => row.id !== postId,
  );
  saveCommunityHomePosts(serverId, next, storage);
  return next;
}

export function addCommunityHomeComment(
  serverId: string,
  postId: string,
  authorName: string,
  body: string,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const trimmed = body.trim();
  if (!trimmed) {
    return loadCommunityHomePosts(serverId, storage);
  }
  const comment: CommunityHomeComment = {
    id: newId("cmt"),
    authorName: authorName.trim() || "você",
    body: trimmed,
    createdAt: new Date().toISOString(),
  };
  return updateCommunityHomePost(
    serverId,
    postId,
    {
      comments: [
        ...(loadCommunityHomePosts(serverId, storage).find((p) => p.id === postId)
          ?.comments ?? []),
        comment,
      ],
    },
    storage,
  );
}

export function deleteCommunityHomeComment(
  serverId: string,
  postId: string,
  commentId: string,
  storage: StorageLike = browserStorage(),
): CommunityHomePost[] {
  const post = loadCommunityHomePosts(serverId, storage).find((p) => p.id === postId);
  if (!post) {
    return loadCommunityHomePosts(serverId, storage);
  }
  return updateCommunityHomePost(
    serverId,
    postId,
    {
      comments: post.comments.filter((c) => c.id !== commentId),
    },
    storage,
  );
}

/** Posts the current viewer may see in the public feed. */
export function visibleCommunityHomePosts(
  posts: readonly CommunityHomePost[],
  opts: { canManageServer: boolean },
): CommunityHomePost[] {
  return posts.filter((post) => {
    if (post.status === "published") {
      return true;
    }
    return opts.canManageServer;
  });
}

export function homeMediaKindFromFile(file: File): "image" | "video" | "file" {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type === "video/mp4" || type === "video/webm") {
    return "video";
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".mp4") || name.endsWith(".webm")) {
    return "video";
  }
  return "file";
}

export function homeMediaFromFile(
  file: File,
  dataUrl: string,
): CommunityHomeMedia {
  const kind = homeMediaKindFromFile(file);
  return {
    kind,
    name: file.name,
    sizeLabel: formatHomeBytes(file.size),
    sizeBytes: file.size,
    dataUrl,
    mock: false,
  };
}

export function homeMediaFromYoutube(url: string): CommunityHomeMedia | null {
  if (!parseYoutubeVideoId(url)) {
    return null;
  }
  return {
    kind: "youtube",
    name: "YouTube",
    sizeLabel: "embed",
    youtubeUrl: url.trim(),
    mock: false,
  };
}

/**
 * @deprecated Voice CTAs were removed from Home. Kept as a no-op export so any
 * leftover import fails loudly at call sites that still expect a channel id —
 * prefer deleting the call site instead.
 */
export function resolveHomeVoiceChannelId(
  _channels: readonly { id: string; name: string; type: string }[],
  _preferredName: string | null,
): string | null {
  return null;
}
