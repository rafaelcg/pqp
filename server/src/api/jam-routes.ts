import {
  addJamTrackSchema,
  createJamSongSchema,
  createJamUploadSchema,
  hasPermission,
  JAM_MAX_TRACKS_PER_AUTHOR,
  JAM_MAX_TRACKS_PER_SONG,
  JAM_PUBLIC_ERRORS,
  listJamSongsQuerySchema,
  Permission,
  setJamCoverSchema,
  updateJamSongSchema,
  updateJamTrackSchema,
  type JamFrame,
  type JamSongDetailResponse,
  type JamSongSummary,
  type JamVoteResponse,
} from "@pqp/shared";
import { HttpError, readJsonBody } from "../lib/http.js";
import { jamChannelsEnabled, jamConfigForServer, JAM_CHANNELS_OFF } from "../lib/jam-config.js";
import { jamPublicEnabled, JAM_PUBLIC_OFF } from "../lib/jam-public-config.js";
import { Created, NoContent } from "../lib/route-results.js";
import type { Router } from "../lib/router.js";
import {
  addableInstruments,
  addJamTrack,
  assertMayAddAny,
  countJamTracks,
  createJamSong,
  deleteJamSong,
  deleteJamTrack,
  getJamSongRow,
  getJamSongSummary,
  getJamSongSummaryPublicView,
  getJamTrackRow,
  JAM_NOT_FOUND,
  listJamSongs,
  listJamTracks,
  listJamTracksPublicView,
  listVotedTrackIds,
  mintJamUpload,
  removeJamCover,
  setJamCover,
  setJamVote,
  updateJamSong,
  updateJamTrack,
  type JamSongRow,
} from "../services/jam.js";
import {
  assertUnderTakeLimit,
  hasJamPublicAccess,
  isJamSongPublished,
  mayRecordPublicly,
  noteJamCoverChanged,
  noteJamTrackAdded,
} from "../services/jam-public.js";
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
 * PUBLIC ACCESS (packages/shared/src/jam-public.ts). A song route reached by
 * somebody who cannot see the song's channel (or for a standalone public jam,
 * which has no channel) is answered only when `hasJamPublicAccess` says so:
 * the song is listed publicly and the flag `jam_public` is on, or it is the
 * caller's own standalone song. Then: the flag that gates writes is
 * `jam_public` (not `jam_channels`), "can post" is "may record publicly" (no
 * block, no ban from the song's server), nobody is a moderator, an add-track
 * must carry `publicConsent` and is created out of the mix unless the caller
 * started the song, and a read sees only the public tracks plus the caller's
 * own, named by account, with no channel (`JamSummaryView` in `jam.ts`). A
 * channel member keeps the channel path exactly as it was.
 *
 * Timeouts. `handleApi`'s timeout gate covers a write whose path names a
 * channel (`/api/channels/:id/...`); the routes that name a song or a track do
 * not carry a channel in the path, so each write here asks for the sanction
 * itself, like `PATCH /api/forum-posts/:postId`.
 *
 * Realtime. Every write that changed something is announced to the channel's
 * viewers AFTER it committed (`announceJam`), so a frame never describes
 * something that can still roll back. A failure to announce is the channel
 * relay's problem and never fails the write. A standalone song has no channel
 * and announces nothing.
 */

interface JamChannel {
  id: string;
  server_id: string;
}

/** How the caller reaches a song: through its channel, or through public access. */
type JamAccess = { kind: "channel"; channel: JamChannel } | { kind: "public" };

/** A jam channel the caller can see, or null. */
async function findJamChannel(channelId: string, userId: string): Promise<JamChannel | null> {
  const channel = await getChannel(channelId);
  if (
    !channel ||
    channel.kind !== "server" ||
    channel.type !== "jam" ||
    !channel.server_id ||
    !(await canAccessChannel(channelId, userId))
  ) {
    return null;
  }
  return { id: channel.id, server_id: channel.server_id };
}

/** A jam channel the caller can see. 404 for anything else. */
async function requireJamChannel(channelId: string, userId: string): Promise<JamChannel> {
  const channel = await findJamChannel(channelId, userId);
  if (!channel) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return channel;
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
  channelId: string | null,
  song: JamSongSummary,
): void {
  if (song.trackCount === 0 || channelId === null) {
    return;
  }
  announceJam({ type, channelId, song });
}

/** Announce to the song's channel; a standalone song has none and announces nothing. */
function announceIn(channelId: string | null, build: (channelId: string) => JamFrame): void {
  if (channelId !== null) {
    announceJam(build(channelId));
  }
}

/** A live song the caller can see, with how they reach it. */
async function requireSong(
  songId: string,
  userId: string,
): Promise<{ song: JamSongRow; access: JamAccess }> {
  const song = await getJamSongRow(songId);
  if (!song) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  if (song.channel_id !== null) {
    const channel = await findJamChannel(song.channel_id, userId);
    if (channel) {
      return { song, access: { kind: "channel", channel } };
    }
  }
  if (await hasJamPublicAccess(song, userId)) {
    return { song, access: { kind: "public" } };
  }
  throw new HttpError(404, JAM_NOT_FOUND);
}

/**
 * The write gate: `jam_channels` for the server (a server id, or channel
 * access), `jam_public` for public access.
 */
function requireOn(target: string | JamAccess): void {
  if (typeof target === "string" || target.kind === "channel") {
    const serverId = typeof target === "string" ? target : target.channel.server_id;
    if (!jamChannelsEnabled(serverId)) {
      throw new HttpError(403, JAM_CHANNELS_OFF);
    }
    return;
  }
  if (!jamPublicEnabled()) {
    throw new HttpError(403, JAM_PUBLIC_OFF);
  }
}

/** Whether the write gate for this access is open (the detail's "may add" reading). */
function isOn(access: JamAccess): boolean {
  return access.kind === "channel" ? jamChannelsEnabled(access.channel.server_id) : jamPublicEnabled();
}

async function channelPerms(channel: JamChannel, userId: string) {
  const perms = await computeMemberPermissions(channel.server_id, userId, channel.id);
  return {
    canPost: hasPermission(perms, Permission.SEND_MESSAGES),
    isModerator:
      hasPermission(perms, Permission.MANAGE_MESSAGES) ||
      hasPermission(perms, Permission.MANAGE_CHANNELS),
  };
}

async function permsOf(access: JamAccess, userId: string, song: JamSongRow) {
  if (access.kind === "channel") {
    return channelPerms(access.channel, userId);
  }
  return { canPost: await mayRecordPublicly(userId, song), isModerator: false };
}

/** A timed-out member takes no part: no write, from a route the gate cannot see. */
async function assertNotTimedOut(userId: string, access: JamAccess): Promise<void> {
  if (access.kind !== "channel") {
    return;
  }
  const timeout = await findTimeoutForChannel(userId, access.channel.id);
  if (timeout) {
    throw new HttpError(403, timeoutMessage(timeout));
  }
}

const isSongAuthor = (song: { author_id: string | null }, userId: string): boolean =>
  song.author_id !== null && song.author_id === userId;

/**
 * Whether the caller sees the whole song: through its channel, or as the
 * starter of a standalone song (it is theirs, and it has no server to leak).
 * Anybody else with public access sees the public view.
 */
const seesWholeSong = (access: JamAccess, song: JamSongRow, userId: string): boolean =>
  access.kind === "channel" || (song.channel_id === null && isSongAuthor(song, userId));

/**
 * The summary to hand THIS caller, after a write that has the channel's view in
 * hand. Never the channel's view to a caller who may only see the public one:
 * a song that stopped being readable between the access check and this read
 * (gone, or deleted) is a 404, not a fallback to what the channel sees.
 */
async function summaryForCaller(
  access: JamAccess,
  song: JamSongRow,
  userId: string,
  channelView: JamSongSummary,
): Promise<JamSongSummary> {
  if (seesWholeSong(access, song, userId)) {
    return channelView;
  }
  const publicView = await getJamSongSummaryPublicView(song.id, userId);
  if (!publicView) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return publicView;
}

/** Vote or take a vote back, and announce it when the count moved. */
async function vote(
  trackId: string,
  userId: string,
  voted: boolean,
): Promise<JamVoteResponse> {
  const track = await getJamTrackRow(trackId);
  if (!track || track.channel_id === null) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  const channel = await requireJamChannel(track.channel_id, userId);
  if (voted) {
    requireOn(channel.server_id);
    await assertNotTimedOut(userId, { kind: "channel", channel });
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
    const { canPost } = await channelPerms(channel, user.id);
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
    const { song, access } = await requireSong(songId!, user.id);
    const whole = seesWholeSong(access, song, user.id);
    const [summary, tracks, voted, perms, timeout, counts] = await Promise.all([
      whole ? getJamSongSummary(song.id) : getJamSongSummaryPublicView(song.id, user.id),
      whole ? listJamTracks(song.id) : listJamTracksPublicView(song.id, user.id),
      access.kind === "channel" ? listVotedTrackIds(song.id, user.id) : Promise.resolve([]),
      permsOf(access, user.id, song),
      access.kind === "channel"
        ? findTimeoutForChannel(user.id, access.channel.id)
        : Promise.resolve(null),
      // The limits count every live track, whatever this caller is shown: a
      // count, not a second list, for the public view.
      whole ? Promise.resolve(null) : countJamTracks(song.id, user.id),
    ]);
    // A song with no track yet is its author's alone, here as on the list.
    if (!summary || (summary.trackCount === 0 && !isSongAuthor(song, user.id))) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const total = counts ? counts.total : tracks.length;
    const mine = counts ? counts.mine : tracks.filter((track) => track.authorId === user.id).length;
    const open =
      isOn(access) &&
      timeout === null &&
      total < JAM_MAX_TRACKS_PER_SONG &&
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
    const { song, access } = await requireSong(songId!, user.id);
    requireOn(access);
    await assertNotTimedOut(user.id, access);
    const perms = await permsOf(access, user.id, song);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const patch = updateJamSongSchema.parse(await readJsonBody(req));
    const updated = await updateJamSong(song, patch);
    announceSong("jam-song-updated", song.channel_id, updated);
    return { song: await summaryForCaller(access, song, user.id, updated) };
  });

  // Delete a song and its tracks: its author or a moderator. Allowed while
  // the flag is off.
  // `?ifEmpty=true` (the studio cleaning up a song it made and never filled):
  // refused with 409 `jam_song_not_empty` when a take is in it.
  router.delete("/api/jam-songs/:songId", async ({ url, user }, { songId }) => {
    const { song, access } = await requireSong(songId!, user.id);
    await assertNotTimedOut(user.id, access);
    const perms = await permsOf(access, user.id, song);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot delete this song");
    }
    if (await deleteJamSong(song.id, { onlyIfEmpty: url.searchParams.get("ifEmpty") === "true" })) {
      announceIn(song.channel_id, (channelId) => ({
        type: "jam-song-deleted",
        channelId,
        songId: song.id,
      }));
    }
    return new NoContent();
  });

  // --------------------------------------------------------------- uploads

  // Step 1 of adding a track: a presigned PUT for the audio, or for the video.
  router.post("/api/jam-songs/:songId/uploads", async ({ req, user }, { songId }) => {
    const { song, access } = await requireSong(songId!, user.id);
    requireOn(access);
    await assertNotTimedOut(user.id, access);
    const perms = await permsOf(access, user.id, song);
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
    const { song, access } = await requireSong(songId!, user.id);
    requireOn(access);
    await assertNotTimedOut(user.id, access);
    const perms = await permsOf(access, user.id, song);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const { uploadId } = setJamCoverSchema.parse(await readJsonBody(req));
    const result = await setJamCover({
      song,
      userId: user.id,
      uploadId,
      late: (summary) => announceSong("jam-song-updated", song.channel_id, summary),
    });
    // A public song's new picture is not public until the scanner passes it.
    await noteJamCoverChanged(song.id);
    // Announced even for a retried claim: a frame is applied by id and is
    // idempotent, and the retry may be the first call whose summary read failed
    // after the commit, so no other viewer has heard of the change yet.
    announceSong("jam-song-updated", song.channel_id, result.song);
    return { song: await summaryForCaller(access, song, user.id, result.song) };
  });

  // Take the picture off. Allowed while the flag is off: a picture somebody
  // should not see stays removable in a paused feature.
  router.delete("/api/jam-songs/:songId/cover", async ({ user }, { songId }) => {
    const { song, access } = await requireSong(songId!, user.id);
    await assertNotTimedOut(user.id, access);
    const perms = await permsOf(access, user.id, song);
    if (!isSongAuthor(song, user.id) && !perms.isModerator) {
      throw new HttpError(403, "You cannot edit this song");
    }
    const result = await removeJamCover(song, (summary) =>
      announceSong("jam-song-updated", song.channel_id, summary),
    );
    // Same reasoning as the claim: announcing a removal that already happened is harmless.
    announceSong("jam-song-updated", song.channel_id, result.song);
    return { song: await summaryForCaller(access, song, user.id, result.song) };
  });

  // ---------------------------------------------------------------- tracks

  // Step 3: claim the uploads as a track. 201, or 200 for a retry.
  router.post("/api/jam-songs/:songId/tracks", async ({ req, user }, { songId }) => {
    const { song, access } = await requireSong(songId!, user.id);
    requireOn(access);
    await assertNotTimedOut(user.id, access);
    const { canPost } = await permsOf(access, user.id, song);
    const request = addJamTrackSchema.parse(await readJsonBody(req));
    // Public access: the recorder was told the part goes public and answered.
    if (access.kind === "public" && !request.publicConsent) {
      throw new HttpError(400, JAM_PUBLIC_ERRORS.consentRequired);
    }
    // A take on a published song counts toward the daily public take limit.
    // Only asked while the flag is on: with it off nothing is public, and a
    // channel's track adds pay no extra lookup. (A take added to a published
    // song while the flag was off stays private until the starter publishes
    // again, which writes the missing rows: fail closed.)
    const published = jamPublicEnabled() && (await isJamSongPublished(song.id));
    if (published) {
      await assertUnderTakeLimit(user.id);
    }
    // An outside take is a request: out of the mix until the starter puts it in.
    const outside = access.kind === "public" && !isSongAuthor(song, user.id);
    const result = await addJamTrack({
      song,
      userId: user.id,
      canPost,
      request,
      forceOutOfMix: outside,
    });
    if (!result.created) {
      // A retry of a claim whose public row the first request did not get to
      // write (it is idempotent, so a row already there is left alone).
      if (published) {
        await noteJamTrackAdded({
          song,
          trackId: result.track.id,
          userId: user.id,
          outside,
          publicConsent: request.publicConsent,
        });
      }
      return {
        track: result.track,
        song: await summaryForCaller(access, song, user.id, result.song),
      };
    }
    if (published) {
      await noteJamTrackAdded({
        song,
        trackId: result.track.id,
        userId: user.id,
        outside,
        publicConsent: request.publicConsent,
      });
    }
    announceIn(song.channel_id, (channelId) => ({
      type: "jam-track-added",
      channelId,
      song: result.song,
      track: result.track,
    }));
    return new Created({
      track: result.track,
      song: await summaryForCaller(access, song, user.id, result.song),
    });
  });

  // Edit a track, field by field (jam.ts header): the track's author owns
  // label, offset, trims and gain; the song's author or a moderator owns inMix.
  router.patch("/api/jam-tracks/:trackId", async ({ req, user }, { trackId }) => {
    const track = await getJamTrackRow(trackId!);
    if (!track) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const { song, access } = await requireSong(track.song_id, user.id);
    // Through public access a caller acts only on their own takes, unless the
    // song is theirs.
    if (!seesWholeSong(access, song, user.id) && track.author_id !== user.id) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    requireOn(access);
    await assertNotTimedOut(user.id, access);
    const patch = updateJamTrackSchema.parse(await readJsonBody(req));
    const perms = await permsOf(access, user.id, song);
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
    announceIn(song.channel_id, (channelId) => ({
      type: "jam-track-updated",
      channelId,
      song: updated.song,
      track: updated.track,
    }));
    return {
      track: updated.track,
      song: await summaryForCaller(access, song, user.id, updated.song),
    };
  });

  // Delete a track: its author, the song's author or a moderator. Allowed
  // while the flag is off. A track's author may always delete their own
  // recording, even after losing sight of the song (a public song that
  // stopped being public): it is their data.
  router.delete("/api/jam-tracks/:trackId", async ({ user }, { trackId }) => {
    const track = await getJamTrackRow(trackId!);
    if (!track) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    let reached: { song: JamSongRow; access: JamAccess } | null = null;
    try {
      reached = await requireSong(track.song_id, user.id);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404 || track.author_id !== user.id) {
        throw error;
      }
    }
    let isModerator = false;
    if (reached) {
      await assertNotTimedOut(user.id, reached.access);
      isModerator = (await permsOf(reached.access, user.id, reached.song)).isModerator;
      if (track.author_id !== user.id && track.song_author_id !== user.id && !isModerator) {
        throw new HttpError(403, "You cannot delete this track");
      }
    }
    // The last track of a song takes the song with it, when the person is the
    // song's author or a moderator: an empty song is a tile that plays nothing.
    // Somebody else's last take (an open song) leaves the author's song empty,
    // which only the author sees: the room is told the song is gone (a
    // `jam-track-deleted` would carry the now author-only summary to everybody,
    // and the phones, which have no such rule, would keep an empty tile), and the
    // author's own wall reads the song again the next time it asks.
    const gone = await deleteJamTrack(track, {
      dropEmptySong: track.song_author_id === user.id || isModerator,
    });
    if (gone?.songDeleted || gone?.song?.trackCount === 0) {
      announceIn(track.channel_id, (channelId) => ({
        type: "jam-song-deleted",
        channelId,
        songId: track.song_id,
      }));
    } else if (gone?.song) {
      const song = gone.song;
      announceIn(track.channel_id, (channelId) => ({
        type: "jam-track-deleted",
        channelId,
        song,
        trackId: track.id,
      }));
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
