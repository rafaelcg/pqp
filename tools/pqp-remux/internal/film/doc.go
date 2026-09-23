// Package film turns one finished low-latency session into ONE ordinary,
// playable video file: the "Vídeo (stream)" download of an LL broadcast.
//
// WHY A JOB AND NOT A STREAM. The conventional ladder's download is its
// MPEG-TS segments concatenated byte for byte, which is a real file because
// MPEG-TS is a stream format. An LL session is CMAF: fragmented MP4 whose
// segments only mean something against an init segment, and every encoder
// restart on the presenter's side (a resolution change, a lost keyframe)
// starts a new init. The 2026-09-21 show had 35 of them, bouncing between
// 270p and 720p, and its video and audio are two separate renditions rather
// than two tracks of one. No byte concatenation of that is a file an editor,
// QuickTime or a phone will open, so the download has to be made, once,
// after the show.
//
// WHAT IT DOES, in the order the 2026-09-22 hand recovery proved works:
//
//  1. Split each track's VOD playlist into groups: a run of segments that
//     share one init and no DISCONTINUITY between them.
//  2. Download every segment and write each group as init + segments, which
//     IS a valid fragmented MP4.
//  3. Read each group's first tfdt, and lay the groups on one timeline
//     (timeline.go): an init change keeps the session's clock, a watchdog
//     restart starts it over, and the second is detected as time going
//     backwards and moved to follow what came before.
//  4. Remux each group to MPEG-TS at its place on that timeline, concatenate
//     per track, mux the two tracks into one TS.
//  5. Re-encode to 1280x720 at a constant 30 fps (H.264 + AAC, faststart
//     MP4), because a file whose resolution changes 35 times is still not
//     one an editor wants. Niced and thread-capped: this box runs the next
//     show's live transcodes too.
//  6. Upload `<prefix>/film.mp4` beside the segments, so the retention sweep
//     (`server/src/voice/hls-cleanup.ts`, which deletes everything under the
//     session's prefix) takes the film with the session and `keep_replay`
//     keeps it with the session, with no extra bookkeeping.
//
// `<prefix>/film.json` says where the job is (queued, processing, ready,
// failed) with a heartbeat, which is how the API tells "being prepared" from
// "this recording has no film" (`server/src/voice/hls-history.ts`).
package film
