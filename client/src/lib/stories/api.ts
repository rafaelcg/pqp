import type {
  CreateStoryRequest,
  CreateStoryResponse,
  PublishStoryResponse,
  StoriesConfig,
  StoriesResponse,
  Story,
  StoryAudienceOptions,
  StoryCard,
  StoryNoticesResponse,
  StoryReaction,
  StoryReplyResponse,
  StorySaveToBauResponse,
  StoryStrip,
  StoryViewersPage,
} from "@pqp/shared";
import { STORY_IDS_MAX } from "@pqp/shared";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * Every stories route, in one place. The wire contract is
 * `packages/shared/src/stories.ts`; nothing here reshapes what the server
 * sends, because three clients read the same answers.
 *
 * A route that answers 204 goes through `noContent`: `apiFetch` only reads
 * JSON and reports an empty success as a failure with status 204.
 */

async function noContent(path: string, init: RequestInit): Promise<void> {
  try {
    await apiFetch<unknown>(path, init);
  } catch (error) {
    if (error instanceof ApiError && error.status === 204) {
      return;
    }
    throw error;
  }
}

function json(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, body: JSON.stringify(body) };
}

/** The strip a flag-off server answers, so a caller never special-cases a 404. */
export const STORY_STRIP_OFF: StoryStrip = {
  enabled: false,
  canPost: false,
  own: null,
  items: [],
  firstRunHint: false,
};

export const fetchStoriesConfig = (serverId?: string | null) =>
  apiFetch<StoriesConfig>(
    serverId
      ? `/api/stories/config?serverId=${encodeURIComponent(serverId)}`
      : "/api/stories/config",
  );

export const fetchServerStoryStrip = (serverId: string, signal?: AbortSignal) =>
  apiFetch<StoryStrip>(`/api/servers/${serverId}/stories`, { signal });

/**
 * The friends strip. Its route is a 404 while `stories_friends` is off on an
 * older server; that reads as the strip being off, never as an error.
 */
export async function fetchFriendsStoryStrip(
  signal?: AbortSignal,
): Promise<StoryStrip> {
  try {
    return await apiFetch<StoryStrip>("/api/stories/friends", { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return STORY_STRIP_OFF;
    }
    throw error;
  }
}

export const fetchStoryAudiences = () =>
  apiFetch<StoryAudienceOptions>("/api/stories/audiences");

/**
 * The stories the viewer may see among `ids`, in the order asked for. The
 * route answers at most `STORY_IDS_MAX` per call and drops what the viewer may
 * not see, so a longer list is fetched in chunks and a missing id is simply
 * absent from the answer.
 */
export async function fetchStories(ids: readonly string[]): Promise<Story[]> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += STORY_IDS_MAX) {
    chunks.push(unique.slice(index, index + STORY_IDS_MAX));
  }
  const answers = await Promise.all(
    chunks.map((chunk) =>
      apiFetch<StoriesResponse>(
        `/api/stories?ids=${chunk.map(encodeURIComponent).join(",")}`,
      ),
    ),
  );
  const byId = new Map<string, Story>();
  for (const answer of answers) {
    for (const story of answer.stories) {
      byId.set(story.id, story);
    }
  }
  return unique.flatMap((id) => {
    const story = byId.get(id);
    return story ? [story] : [];
  });
}

export const createStory = (body: CreateStoryRequest) =>
  apiFetch<CreateStoryResponse>("/api/stories", json("POST", body));

export const publishStory = (storyId: string) =>
  apiFetch<PublishStoryResponse>(
    `/api/stories/${storyId}/publish`,
    json("POST"),
  );

export const deleteStory = (storyId: string) =>
  noContent(`/api/stories/${storyId}`, json("DELETE"));

export const recordStoryViews = (storyIds: readonly string[]) =>
  apiFetch<{ recorded: number }>(
    "/api/stories/views",
    json("POST", { storyIds }),
  );

export const setStoryReaction = (storyId: string, reaction: StoryReaction | null) =>
  apiFetch<{ reaction: StoryReaction | null }>(
    `/api/stories/${storyId}/reaction`,
    json("PUT", { reaction }),
  );

/**
 * `nonce` makes a retry idempotent: the server answers the reply that already
 * landed instead of sending the DM twice. Reuse it for a retry of the same
 * text; mint a new one for a new reply.
 */
export const replyToStory = (storyId: string, text: string, nonce: string) =>
  apiFetch<StoryReplyResponse>(
    `/api/stories/${storyId}/reply`,
    json("POST", { text, nonce }),
  );

export const fetchStoryViewers = (storyId: string, cursor?: string | null) =>
  apiFetch<StoryViewersPage>(
    cursor
      ? `/api/stories/${storyId}/viewers?cursor=${encodeURIComponent(cursor)}`
      : `/api/stories/${storyId}/viewers`,
  );

export const fetchStoryCard = (storyId: string) =>
  apiFetch<StoryCard>(`/api/stories/${storyId}/card`);

export const removeStoryFromServer = (
  serverId: string,
  storyId: string,
  reason?: string,
) =>
  noContent(
    `/api/servers/${serverId}/stories/${storyId}`,
    json("DELETE", reason ? { reason } : {}),
  );

export const muteStoryAuthor = (userId: string) =>
  noContent(`/api/stories/mutes/${userId}`, json("PUT"));

export const unmuteStoryAuthor = (userId: string) =>
  noContent(`/api/stories/mutes/${userId}`, json("DELETE"));

export const fetchStoryNotices = () =>
  apiFetch<StoryNoticesResponse>("/api/stories/notices");

export const ackStoryNotice = (noticeId: string) =>
  noContent(`/api/stories/notices/${noticeId}/ack`, json("POST"));

export const saveStoryToBau = (storyId: string, serverId: string) =>
  apiFetch<StorySaveToBauResponse>(
    `/api/stories/${storyId}/save-to-bau`,
    json("POST", { serverId }),
  );
