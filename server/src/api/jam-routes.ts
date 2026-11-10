import {
  addJamTrackSchema,
  createJamSongSchema,
  createJamUploadSchema,
  hasPermission,
  JAM_MAX_TRACKS_PER_AUTHOR,
  JAM_MAX_TRACKS_PER_SONG,
  listJamSongsQuerySchema,
  Permission,
  setJamCoverSchema,
  updateJamSongSchema,
  updateJamTrackSchema,
  type JamSongDetailResponse,
  type JamSongSummary,
  type JamVoteResponse,
} from "@pqp/shared";
import { HttpError, readJsonBody } from "../lib/http.js";
import { jamChannelsEnabled, jamConfigForServer, JAM_CHANNELS_OFF } from "../lib/jam-config.js";
import { Created, NoContent } from "../lib/route-results.js";
import type { Router } from "../lib/router.js";
import {
  addableInstruments,
  addJamTrack,
  assertMayAddAny,
  createJamSong,
  deleteJamSong,
  deleteJamTrack,
  getJamSongRow,
  getJamSongSummary,
  getJamTrackRow,
  JAM_NOT_FOUND,
  listJamSongs,
  listJamTracks,
  listVotedTrackIds,
  mintJamUpload,
  removeJamCover,
  setJamCover,
  setJamVote,
  updateJamSong,
  updateJamTrack,
  type JamSongRow,
} from "../services/jam.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { findTimeoutForChannel, timeoutMessage } from "../services/sanctions.js";
import { getChannel } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
import { announceJam } from "../ws/chat.js";

/**
 * JAM CHANNELS' ROUTES (docs/JAM.md; the contract, with every rule, is
 * `packages/shared/src/jam.ts`), mounted from `api/index.ts` with
 * `registerJamRoutes(router)`. Authenticated like every router route: the
 * Bearer is resolved before they run.
 *
 * The order of refusals, the same on every route, so a client can tell them
 * apart: 404 for anything the caller may not see (a channel they cannot open,
 * a song or track in it, a channel that is not a jam: one answer, no oracle),
 * then 403 `jam_channels_off` for a write while the runtime flag is off for the
 * server, then the permission, then the body. Reads never look at the flag.
 * Four removals do not either (delete a song, delete a track, unvote, remove a
 * cover): a
 * switched-off feature is frozen, not a place content or moderation gets
 * stuck.
 *
 * Who is who. "Can post" is SEND_MESSAGES on the jam channel, overwrites
 * included. A moderator is MANAGE_MESSAGES or MANAGE_CHANNELS on it (the
 * forum's pair). `canAccessChannel` is the visibility rule for everything, so
 * a private channel's songs and tracks fail closed with no jam-specific code.
 *
 * Timeouts. `handleApi`'s timeout gate covers a write whose path names a
 * channel (`/api/channels/:id/...`); the routes that name a song or a track do
 * not carry a channel in the path, so each write here asks for the sanction
 * itself, like `PATCH /api/forum-posts/:postId`.
 *
 * Realtime. Every write that changed something is announced to the channel's
 * viewers AFTER it committed (`announceJam`), so a frame never describes
 * something that can still roll back. A failure to announce is the channel
 * relay's problem and never fails the write.
 */

interface JamChannel {
  id: string;
  server_id: string;
}

/** A jam channel the caller can see. 404 for anything else. */
async function requireJamChannel(channelId: string, userId: string): Promise<JamChannel> {
  const channel = await getChannel(channelId);
  if (
    !channel ||
    channel.kind !== "server" ||
    channel.type !== "jam" ||
    !channel.server_id ||
    !(await canAccessChannel(channelId, userId))
  ) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return { id: channel.id, server_id: channel.server_id };
}

/**
 * A song with no track is its author's alone (the list leaves it out for
 * everybody else), so its create and update frames, which go to the whole
 * channel, are not sent: the author's own client applies the answer to the
 * request. The first track announces the song to the room (`jam-track-added`
 * carries the song).
 */
function announceSong(
  type: "jam-song-created" | "jam-song-updated",
  channelId: string,
  song: JamSongSummary,
): void {
  if (song.trackCount === 0) {
    return;
  }
  announceJam({ type, channelId, song });
}

/** A live song the caller can see, with its channel. */
async function requireSong(
  songId: string,
  userId: string,
): Promise<{ song: JamSongRow; channel: JamChannel }> {
  const song = await getJamSongRow(songId);
  if (!song) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  const channel = await requireJamChannel(song.channel_id, userId);
  return { song, channel };
}

function requireOn(serverId: string): void {
  if (!jamChannelsEnabled(serverId)) {
    throw new HttpError(403, JAM_CHANNELS_OFF);
  }
}

async function permsOf(channel: JamChannel, userId: string) {
  const perms = await computeMemberPermissions(channel.server_id, userId, channel.id);
  return {
    canPost: hasPermission(perms, Permission.SEND_MESSAGES),
    isModerator:
      hasPermission(perms, Permission.MANAGE_MESSAGES) ||
      hasPermission(perms, Permission.MANAGE_CHANNELS),
  };
}

/** A timed-out member takes no part: no write, from a route the gate cannot see. */
async function assertNotTimedOut(userId: string, channelId: string): Promise<void> {
  const timeout = await findTimeoutForChannel(userId, channelId);
  if (timeout) {
    throw new HttpError(403, timeoutMessage(timeout));
  }
}

const isSongAuthor = (song: { author_id: string | null }, userId: string): boolean =>
  song.author_id !== null && song.author_id === userId;

/** Vote or take a vote back, and announce it when the count moved. */
async function vote(
  trackId: string,
  userId: string,
  voted: boolean,
): Promise<JamVoteResponse> {
  const track = await getJamTrackRow(trackId);
  if (!track) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  const channel = await requireJamChannel(track.channel_id, userId);
  if (voted) {
    requireOn(channel.server_id);
    await assertNotTimedOut(userId, channel.id);
  }
  const result = await setJamVote(track.id, userId, voted);
  if (result.changed) {
    announceJam({
      type: "jam-track-votes",
      channelId: channel.id,
      songId: track.song_id,
      trackId: track.id,
      voteCount: result.voteCount,
    });
  }
  return { trackId: track.id, songId: track.song_id, voteCount: result.voteCount, voted };
}

export function registerJamRoutes(router: Router): void {
  // The flag for one server, plus whether storage is configured. A missing or
  // malformed serverId is the global answer (nothing to ask about).
  router.get("/api/jam/config", async ({ url }) =>
    jamConfigForServer(url.searchParams.get("serverId")),
  );

  // ---------------------------------------------------------------- songs

  router.get("/api/channels/:channelId/jam-songs", async ({ url, user }, { channelId }) => {
    await requireJamChannel(channelId!, user.id);
    const query = listJamSongsQuerySchema.parse({
      sort: url.searchParams.get("sort") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      wanting: url.searchParams.get("wanting") ?? undefined,
      mine: url.searchParams.get("mine") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return listJamSongs({ channelId: channelId!, viewerId: user.id, query });
  });

  // Create a song. 201, or 200 with the song a repeated nonce already made.
  router.post("/api/channels/:channelId/jam-songs", async ({ req, user }, { channelId }) => {
    const channel = await requireJamChannel(channelId!, user.id);
    requireOn(channel.server_id);
    const { canPost } = await permsOf(channel, user.id);
    if (!canPost) {
      throw new HttpError(403, "You cannot post in this channel");
    }
    const request = createJamSongSchema.parse(await readJsonBody(req));
    const result = await createJamSong({
      channelId: channel.id,
      serverId: channel.server_id,
      authorId: user.id,
      request,
    });
    if (!result.created) {
      return { song: result.song };
    }
    announceSong("jam-song-created", channel.id, result.song);
    return new Created({ song: result.song });
  });

  // One song with its tracks, and what the caller may do in it. The deep link,
  // and where a client that outlived its media URLs gets fresh ones.
  router.get("/api/jam-songs/:songId", async ({ user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    const [summary, tracks, voted, perms, timeout] = await Promise.all([
      getJamSongSummary(song.id),
      listJamTracks(song.id),
      listVotedTrackIds(song.id, user.id),
      permsOf(channel, user.id),
      findTimeoutForChannel(user.id, channel.id),
    ]);
    // A song with no track yet is its author's alone, here as on the list.
    if (!summary || (summary.trackCount === 0 && !isSongAuthor(song, user.id))) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const mine = tracks.filter((track) => track.authorId === user.id).length;
    const open =
      jamChannelsEnabled(channel.server_id) &&
      timeout === null &&
      tracks.length < JAM_MAX_TRACKS_PER_SONG &&
      mine < JAM_MAX_TRACKS_PER_AUTHOR;
    const body: JamSongDetailResponse = {
      song: summary,
      tracks,
      viewer: {
        isAuthor: isSongAuthor(song, user.id),
        canModerate: perms.isModerator,
        addableInstruments: addableInstruments({
          song,
          userId: user.id,
          canPost: open && perms.canPost,
        }),
        votedTrackIds: voted,
      },
    };
    return body;
  });

  // Edit a song: its author or a moderator.
  router.patch("/api/jam-songs/:songId", async ({ req, user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    requireOn(channel.server_id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const patch = updateJamSongSchema.parse(await readJsonBody(req));
    const updated = await updateJamSong(song, patch);
    announceSong("jam-song-updated", channel.id, updated);
    return { song: updated };
  });

  // Delete a song and its tracks: its author or a moderator. Allowed while
  // the flag is off.
  router.delete("/api/jam-songs/:songId", async ({ user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot delete this song");
    }
    if (await deleteJamSong(song.id)) {
      announceJam({ type: "jam-song-deleted", channelId: channel.id, songId: song.id });
    }
    return new NoContent();
  });

  // --------------------------------------------------------------- uploads

  // Step 1 of adding a track: a presigned PUT for the audio, or for the video.
  router.post("/api/jam-songs/:songId/uploads", async ({ req, user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    requireOn(channel.server_id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    const request = createJamUploadSchema.parse(await readJsonBody(req));
    if (request.kind === "cover") {
      // A picture for the song, not a track: the rule of editing it.
      if (!isSongAuthor(song, user.id) && !perms.isModerator) {
        throw new HttpError(403, "You cannot edit this song");
      }
    } else {
      // Somebody who could not add any track gets no signed URL either, so a
      // closed song costs the bucket nothing.
      assertMayAddAny(song, user.id, perms.canPost);
    }
    return new Created(await mintJamUpload({ song, uploaderId: user.id, request }));
  });

  // ----------------------------------------------------------------- cover

  // Step 3 of a cover: claim the upload as the song's picture. The same people
  // as the edit of a title, and the same gates.
  router.put("/api/jam-songs/:songId/cover", async ({ req, user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    requireOn(channel.server_id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const { uploadId } = setJamCoverSchema.parse(await readJsonBody(req));
    const result = await setJamCover({
      song,
      userId: user.id,
      uploadId,
      late: (summary) => announceSong("jam-song-updated", channel.id, summary),
    });
    // Announced even for a retried claim: a frame is applied by id and is
    // idempotent, and the retry may be the first call whose summary read failed
    // after the commit, so no other viewer has heard of the change yet.
    announceSong("jam-song-updated", channel.id, result.song);
    return { song: result.song };
  });

  // Take the picture off. Allowed while the flag is off: a picture somebody
  // should not see stays removable in a paused feature.
  router.delete("/api/jam-songs/:songId/cover", async ({ user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const result = await removeJamCover(song, (summary) =>
      announceSong("jam-song-updated", channel.id, summary),
    );
    // Same reasoning as the claim: announcing a removal that already happened is harmless.
    announceSong("jam-song-updated", channel.id, result.song);
    return { song: result.song };
  });

  // ---------------------------------------------------------------- tracks

  // Step 3: claim the uploads as a track. 201, or 200 for a retry.
  router.post("/api/jam-songs/:songId/tracks", async ({ req, user }, { songId }) => {
    const { song, channel } = await requireSong(songId!, user.id);
    requireOn(channel.server_id);
    await assertNotTimedOut(user.id, channel.id);
    const { canPost } = await permsOf(channel, user.id);
    const request = addJamTrackSchema.parse(await readJsonBody(req));
    const result = await addJamTrack({ song, userId: user.id, canPost, request });
    if (!result.created) {
      return { track: result.track, song: result.song };
    }
    announceJam({
      type: "jam-track-added",
      channelId: channel.id,
      song: result.song,
      track: result.track,
    });
    return new Created({ track: result.track, song: result.song });
  });

  // Edit a track, field by field (jam.ts header): the track's author owns
  // label, offset, trims and gain; the song's author or a moderator owns inMix.
  router.patch("/api/jam-tracks/:trackId", async ({ req, user }, { trackId }) => {
    const track = await getJamTrackRow(trackId!);
    if (!track) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const channel = await requireJamChannel(track.channel_id, user.id);
    requireOn(channel.server_id);
    await assertNotTimedOut(user.id, channel.id);
    const patch = updateJamTrackSchema.parse(await readJsonBody(req));
    const perms = await permsOf(channel, user.id);
    const ownFields =
      patch.label !== undefined ||
      patch.offsetMs !== undefined ||
      patch.trimStartMs !== undefined ||
      patch.trimEndMs !== undefined ||
      patch.gain !== undefined;
    if (ownFields && track.author_id !== user.id) {
      throw new HttpError(403, "You cannot edit somebody else's track");
    }
    if (
      patch.inMix !== undefined &&
      track.song_author_id !== user.id &&
      !perms.isModerator
    ) {
      throw new HttpError(403, "Only the song's author or a moderator sets the mix");
    }
    const updated = await updateJamTrack(track, patch);
    announceJam({
      type: "jam-track-updated",
      channelId: channel.id,
      song: updated.song,
      track: updated.track,
    });
    return updated;
  });

  // Delete a track: its author, the song's author or a moderator. Allowed
  // while the flag is off.
  router.delete("/api/jam-tracks/:trackId", async ({ user }, { trackId }) => {
    const track = await getJamTrackRow(trackId!);
    if (!track) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const channel = await requireJamChannel(track.channel_id, user.id);
    await assertNotTimedOut(user.id, channel.id);
    const perms = await permsOf(channel, user.id);
    if (track.author_id !== user.id && track.song_author_id !== user.id && !perms.isModerator) {
      throw new HttpError(403, "You cannot delete this track");
    }
    // The last track of a song takes the song with it, when the person is the
    // song's author or a moderator: an empty song is a tile that plays nothing.
    // Somebody else's last take (an open song) leaves the author's song empty,
    // which only the author sees.
    const gone = await deleteJamTrack(track, {
      dropEmptySong: track.song_author_id === user.id || perms.isModerator,
    });
    if (gone?.songDeleted) {
      announceJam({ type: "jam-song-deleted", channelId: channel.id, songId: track.song_id });
    } else if (gone?.song) {
      announceJam({
        type: "jam-track-deleted",
        channelId: channel.id,
        song: gone.song,
        trackId: track.id,
      });
    }
    return new NoContent();
  });

  // ----------------------------------------------------------------- votes

  router.put("/api/jam-tracks/:trackId/vote", async ({ user }, { trackId }) =>
    vote(trackId!, user.id, true),
  );
  router.delete("/api/jam-tracks/:trackId/vote", async ({ user }, { trackId }) =>
    vote(trackId!, user.id, false),
  );
}
