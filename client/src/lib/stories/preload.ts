import type { Story } from "@pqp/shared";

/**
 * Warming the next stories, so that going to one shows its first frame with no
 * wait (design §3.2, Preload).
 *
 * WHAT. For a story: its picture (decoded), a video's poster and its first
 * seconds buffered, every photo and drawing layer, and its author's avatar.
 * A video is the last thing a story asks for, and is skipped entirely when the
 * browser says the person is saving data.
 *
 * WHO ASKS. Whoever is looking at stories names the stories it will likely need
 * next, in order, under its own source name: the viewer (the next two stories
 * of the queue, across authors, and the first story of the next author) and each
 * strip (the first unseen story of its first three rings). The viewer outranks
 * the strips. A source that is gone (the viewer closed, a ring left the window)
 * names nothing, and whatever it was still downloading is cancelled.
 *
 * HOW MUCH. At most `MAX_CONCURRENT` downloads at once, so warming never starves
 * the story the person is actually watching. Finished pictures and clips are
 * kept (a few, oldest dropped first) so the viewer can take them: a decoded
 * image stays in the browser's memory cache for its URL, and a buffered `<video>`
 * element is handed over whole (`takePreloadedVideo`), so the clip needs no new
 * request at all.
 *
 * The URLs are presigned and differ on every read, so what is warmed is only
 * ever useful to the very `Story` object it was warmed from. `rememberStories`
 * keeps those objects for a few minutes for the viewer to reuse.
 */

export const MAX_CONCURRENT = 2;
/** Finished pictures kept alive so the browser does not forget them. */
const READY_IMAGES_MAX = 16;
/** Finished clips kept, a clip being heavier. */
const READY_VIDEOS_MAX = 3;
/** A download that has not finished in this long frees its slot (the next story waits behind it otherwise). */
const JOB_TIMEOUT_MS = 20_000;
/** How long a story read for warming may be reused by the viewer: its presigned URLs are what was warmed. */
export const REMEMBER_STORIES_MS = 3 * 60_000;

export type AssetKind = "image" | "video";

export interface PreloadAsset {
  key: string;
  kind: AssetKind;
  url: string;
}

/** The assets of one story, most useful first. */
export function assetsOfStory(story: Story, options: { video: boolean }): PreloadAsset[] {
  const assets: PreloadAsset[] = [];
  const push = (kind: AssetKind, url: string | null | undefined) => {
    if (url) {
      assets.push({ key: `${kind}:${url}`, kind, url });
    }
  };
  if (story.kind === "image") {
    push("image", story.media?.url);
  } else if (story.kind === "video") {
    push("image", story.media?.posterUrl);
  }
  for (const layer of story.layers ?? []) {
    if (layer.type === "image" || layer.type === "drawing") {
      push("image", layer.url);
    }
  }
  push("image", story.author.avatarUrl);
  if (story.kind === "video" && options.video) {
    push("video", story.media?.url);
  }
  return assets;
}

// ------------------------------------------------------------------ environment

export interface ImageLike {
  decoding: string;
  src: string;
  decode?: () => Promise<void>;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

export interface VideoLike {
  preload: string;
  muted: boolean;
  playsInline: boolean;
  src: string;
  readyState: number;
  load: () => void;
  pause: () => void;
  removeAttribute: (name: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface PreloadEnv {
  createImage: () => ImageLike;
  createVideo: () => VideoLike;
  saveData: () => boolean;
}

const browserEnv: PreloadEnv = {
  createImage: () => new Image() as unknown as ImageLike,
  createVideo: () => document.createElement("video") as unknown as VideoLike,
  saveData: () => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return connection?.saveData === true;
  },
};

// ------------------------------------------------------------------ the preloader

interface Job {
  asset: PreloadAsset;
  cancel: () => void;
}

interface Ready {
  asset: PreloadAsset;
  /** A buffered clip, kept to be handed to the viewer; a picture needs no more than to stay referenced. */
  holder: ImageLike | VideoLike;
}

export class StoryPreloader {
  private readonly sources = new Map<string, { priority: number; assets: PreloadAsset[] }>();
  private readonly running = new Map<string, Job>();
  private readonly ready = new Map<string, Ready>();
  private readonly failed = new Set<string>();
  /** Counters for tests and the dev console. */
  readonly stats = { started: 0, cancelled: 0, finished: 0 };

  constructor(private readonly env: PreloadEnv = browserEnv) {}

  /** Replace what `source` wants warmed. Lower `priority` goes first. */
  setSource(source: string, priority: number, assets: readonly PreloadAsset[]): void {
    this.sources.set(source, { priority, assets: [...assets] });
    this.reconcile();
  }

  clearSource(source: string): void {
    if (this.sources.delete(source)) {
      this.reconcile();
    }
  }

  isReady(key: string): boolean {
    return this.ready.has(key);
  }

  activeKeys(): string[] {
    return [...this.running.keys()];
  }

  /** A clip warmed for `url`, taken out of the preloader (it belongs to the viewer now), or null. */
  takeVideo(url: string): VideoLike | null {
    const key = `video:${url}`;
    const found = this.ready.get(key);
    if (!found) {
      return null;
    }
    this.ready.delete(key);
    return found.holder as VideoLike;
  }

  /**
   * A clip the viewer is done with (it moved on, or React remounted it), handed back so going back to
   * it, or the same story remounting, finds the buffer instead of starting over. Kept like any warmed
   * clip, so it is let go in its turn.
   */
  giveVideo(url: string, video: VideoLike): void {
    const key = `video:${url}`;
    video.pause();
    if (this.ready.has(key) || this.running.has(key)) {
      video.removeAttribute("src");
      video.load();
      return;
    }
    this.ready.set(key, { asset: { key, kind: "video", url }, holder: video });
    this.trim(new Set(this.desired().map((asset) => asset.key)));
  }

  /** Cancel everything and forget everything. */
  reset(): void {
    this.sources.clear();
    for (const job of [...this.running.values()]) {
      job.cancel();
    }
    this.running.clear();
    this.ready.clear();
    this.failed.clear();
  }

  private desired(): PreloadAsset[] {
    const seen = new Set<string>();
    const out: PreloadAsset[] = [];
    const ordered = [...this.sources.values()].sort((a, b) => a.priority - b.priority);
    for (const source of ordered) {
      for (const asset of source.assets) {
        if (!seen.has(asset.key)) {
          seen.add(asset.key);
          out.push(asset);
        }
      }
    }
    return out;
  }

  private reconcile(): void {
    const wanted = this.desired();
    const wantedKeys = new Set(wanted.map((asset) => asset.key));
    // Leaving the window cancels what is still downloading.
    for (const [key, job] of [...this.running]) {
      if (!wantedKeys.has(key)) {
        job.cancel();
        this.running.delete(key);
        this.stats.cancelled += 1;
      }
    }
    // What nobody wants any more is let go, oldest first, past the caps.
    this.trim(wantedKeys);
    const allowVideo = !this.env.saveData();
    const rank = new Map(wanted.map((asset, index) => [asset.key, index]));
    for (const asset of wanted) {
      if (
        this.running.has(asset.key) ||
        this.ready.has(asset.key) ||
        this.failed.has(asset.key) ||
        (asset.kind === "video" && !allowVideo)
      ) {
        continue;
      }
      if (this.running.size >= MAX_CONCURRENT) {
        // Full: this one may take the place of the least wanted download that is behind it in the
        // order (the viewer opening while a strip was warming), and otherwise waits its turn.
        let worst: string | null = null;
        for (const key of this.running.keys()) {
          if ((rank.get(key) ?? Infinity) > (rank.get(asset.key) ?? Infinity) && (worst === null || (rank.get(key) ?? Infinity) > (rank.get(worst) ?? Infinity))) {
            worst = key;
          }
        }
        if (worst === null) {
          break;
        }
        this.running.get(worst)!.cancel();
        this.running.delete(worst);
        this.stats.cancelled += 1;
      }
      this.start(asset);
    }
  }

  private trim(wantedKeys: ReadonlySet<string>): void {
    const keep = (kind: AssetKind, max: number) => {
      const keys = [...this.ready.entries()].filter(([, entry]) => entry.asset.kind === kind).map(([key]) => key);
      for (const key of keys) {
        if (keys.length <= max) {
          break;
        }
        if (!wantedKeys.has(key)) {
          this.drop(key);
          keys.splice(keys.indexOf(key), 1);
        }
      }
    };
    keep("image", READY_IMAGES_MAX);
    keep("video", READY_VIDEOS_MAX);
  }

  private drop(key: string): void {
    const entry = this.ready.get(key);
    this.ready.delete(key);
    if (entry?.asset.kind === "video") {
      const video = entry.holder as VideoLike;
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  private start(asset: PreloadAsset): void {
    this.stats.started += 1;
    let settled = false;
    let holder: ImageLike | VideoLike;
    let detach: () => void = () => undefined;
    const settle = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      detach();
      this.running.delete(asset.key);
      if (ok) {
        this.stats.finished += 1;
        this.ready.set(asset.key, { asset, holder });
      } else {
        this.failed.add(asset.key);
      }
      this.reconcile();
    };
    const timer = setTimeout(() => {
      // Too slow to wait behind: give the slot away and try the picture again only if asked again.
      if (!settled) {
        job.cancel();
        this.running.delete(asset.key);
        this.failed.add(asset.key);
        this.reconcile();
      }
    }, JOB_TIMEOUT_MS);

    let job: Job;
    if (asset.kind === "image") {
      const image = this.env.createImage();
      holder = image;
      image.decoding = "async";
      image.onload = () => {
        // Decoded now, so the first paint of the story does not pay for it.
        const decoding = image.decode?.();
        if (decoding) {
          decoding.then(() => settle(true), () => settle(true));
        } else {
          settle(true);
        }
      };
      image.onerror = () => settle(false);
      image.src = asset.url;
      job = {
        asset,
        cancel: () => {
          settled = true;
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          // An empty src aborts a download still in flight.
          image.src = "";
        },
      };
    } else {
      const video = this.env.createVideo();
      holder = video;
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      // The clip is "ready" once the first frame is decodable and the browser has taken what it
      // wants to buffer ahead (`suspend`), or has it all (`canplaythrough`).
      const onReady = () => {
        if (video.readyState >= 2) {
          settle(true);
        }
      };
      const onFail = () => settle(false);
      video.addEventListener("canplaythrough", onReady);
      video.addEventListener("suspend", onReady);
      video.addEventListener("error", onFail);
      detach = () => {
        video.removeEventListener("canplaythrough", onReady);
        video.removeEventListener("suspend", onReady);
        video.removeEventListener("error", onFail);
      };
      video.src = asset.url;
      video.load();
      job = {
        asset,
        cancel: () => {
          settled = true;
          clearTimeout(timer);
          detach();
          video.pause();
          video.removeAttribute("src");
          video.load();
        },
      };
    }
    this.running.set(asset.key, job);
  }
}

/** The app's one preloader. */
export const storyPreloader = new StoryPreloader();

export function takePreloadedVideo(url: string): VideoLike | null {
  return storyPreloader.takeVideo(url);
}

export function giveBackVideo(url: string, video: VideoLike): void {
  storyPreloader.giveVideo(url, video);
}

// ------------------------------------------------------------------ stories read for warming

const remembered = new Map<string, { story: Story; at: number }>();

/** Keep stories just read, for the viewer to reuse while their presigned URLs are what was warmed. */
export function rememberStories(stories: readonly Story[]): void {
  const now = Date.now();
  for (const story of stories) {
    remembered.set(story.id, { story, at: now });
  }
  // Bounded: the strips ask for three at a time, the viewer for a handful.
  while (remembered.size > 60) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    remembered.delete(oldest);
  }
}

/** A story read in the last `REMEMBER_STORIES_MS`, or null. */
export function rememberedStory(id: string, now: number = Date.now()): Story | null {
  const found = remembered.get(id);
  if (!found) {
    return null;
  }
  if (now - found.at > REMEMBER_STORIES_MS) {
    remembered.delete(id);
    return null;
  }
  return found.story;
}

export function resetPreloadForTests(): void {
  storyPreloader.reset();
  remembered.clear();
}
