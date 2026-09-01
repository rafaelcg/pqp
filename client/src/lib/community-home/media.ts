/**
 * Client-only Home media helpers. Bytes never leave the browser; the 10 MiB
 * ceiling is a mock product rule (native short video / file), not an API limit.
 */

export const COMMUNITY_HOME_MAX_BYTES = 10 * 1024 * 1024;

export type CommunityHomeMediaKind =
  | "image"
  | "video"
  | "youtube"
  | "file"
  | "text";

export type CommunityHomeMedia = {
  kind: Exclude<CommunityHomeMediaKind, "text">;
  name: string;
  sizeLabel: string;
  sizeBytes?: number;
  /**
   * Local-only payload (data URL). Used for image / video / file picks.
   * Never uploaded.
   */
  dataUrl?: string | null;
  /**
   * YouTube watch / youtu.be / shorts URL. Must not be rendered into the free
   * DOM when the post is locked — only the unlocked path may build an iframe.
   */
  youtubeUrl?: string | null;
  /** Fixture placeholder with no real bytes. */
  mock?: boolean;
};

/** Human size label for the compose hint and download cards. */
export function formatHomeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024;
    return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  }
  const mib = bytes / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}

/**
 * Extract a YouTube video id from watch / youtu.be / shorts / embed URLs.
 * Returns null for anything else — compose then refuses to treat it as embed.
 */
export function parseYoutubeVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") &&
        parts[1] &&
        /^[\w-]{11}$/.test(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Privacy-friendly embed src. Only call when the viewer may see the media. */
export function youtubeEmbedSrc(youtubeUrl: string): string | null {
  const id = parseYoutubeVideoId(youtubeUrl);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export function isHomeVideoFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4" || type === "video/webm") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".mp4") || name.endsWith(".webm");
}

export function isHomeImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("read failed"));
      }
    };
    reader.readAsDataURL(file);
  });
}
