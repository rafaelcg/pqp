// Package llstate renders `state.json`: the document the edge Worker
// (`tools/hls-edge`) reads to build a low-latency HLS playlist for one
// session, task `L2.3` of `docs/plans/LL_HLS.md`.
//
// WHY THIS EXISTS AT ALL. The Worker renders the LL playlist itself --
// `EXT-X-SERVER-CONTROL`, `EXT-X-PART-INF`, `EXT-X-PART`,
// `EXT-X-PRELOAD-HINT` -- rather than forwarding playlist text this box
// wrote, because this box's own `GET /playlist.m3u8` is (and stays) a
// conventional media playlist listing sealed segments. A renderer needs
// the numbers those tags encode, not somebody else's finished text: which
// segments and parts exist, how long each is, which part starts on an IDR.
// That is this document. Its contract, field for field and rule for rule,
// is the module doc comment of `tools/hls-edge/src/ll-state.js`, and its
// validator is that file's `parseLlState` -- a document that fails it is
// treated by every caller in the Worker exactly like "origin unreachable",
// which means a stalled viewer. So this package's job is not merely to
// serialize the ring; it is to emit only documents that parser ACCEPTS,
// and to emit nothing at all (`ok == false`, a 404 from the HTTP surface)
// when the session cannot yet be described as one.
//
// PRODUCTION, 2026-09-15 08:01 UTC, IS WHY IT EXISTS NOW. The API selected
// LL mode, `pqp-remuxd` started the session and wrote parts and segments
// (`/s/:id/playlist.m3u8`, `init.mp4` and `audio-playlist.m3u8` all
// answered 200), and every viewer stalled anyway: the Worker fetches
// `GET {LL_ORIGIN_BASE}/s/:sessionId/state.json` FIRST and this box
// answered 404, so `hlsEdge.llStateFetchFailed` fired and no playlist was
// ever built. Media on disk is not media a player can find.
//
// THE URIS ARE THE ONES THIS BINARY ACTUALLY SERVES. `ll-state.js`'s
// worked example writes a part as `part-41.0.m4s` (segment, then index
// within it); `internal/serve` serves parts by their GLOBAL CMAF sequence
// number, `part-7.m4s`, and has since `L1.1`. The Worker's parser cares
// only that a URI is a safe relative name (`isSafeUriSegment`), and every
// URI it emits is fetched back from THIS origin, so the honest move is to
// advertise the names that resolve -- never to invent names the box would
// 404. The `index` field inside a part is still the part's position within
// its own segment, because that is what `EXT-X-PRELOAD-HINT`'s arithmetic
// is expressed in on the Worker's side; only the file NAME is a sequence
// number.
//
// BLOCKING RELOAD IS NOT THIS ENDPOINT'S JOB, AND DELIBERATELY SO. RFC
// 8216bis's `_HLS_msn`/`_HLS_part` hold is implemented entirely in the
// Worker (`tools/hls-edge/src/hls-blocking-reload.js`): its poll loop
// re-runs `LlPlaylistOrigin.fetchPlaylist`, which re-fetches THIS document
// and re-renders, until the requested msn/part appears or the hold times
// out. The directives never reach this box -- `ll-playlist-origin.ts`
// builds the origin URL from the session id alone and attaches no query
// string. So `state.json` is a plain, cheap, always-current read with no
// long-poll semantics of its own, and the one thing it owes the hold is
// freshness: it is rendered from the live ring on every request and served
// `Cache-Control: no-store`, so a poll one part-target later observes the
// part that landed in between.
package llstate

import (
	"math"
	"strconv"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// pdtLayout is the #EXT-X-PROGRAM-DATE-TIME shape: RFC 3339 with
// milliseconds, always UTC. Fixed-width on purpose (RFC3339Nano trims
// trailing zeros, which makes an otherwise identical document differ byte
// for byte depending on when it was stamped -- unhelpful for a golden file
// and for anyone diffing two captures).
const pdtLayout = "2006-01-02T15:04:05.000Z07:00"

// minDurationSecs is the floor applied to any part or segment duration.
// `parseLlState` rejects the WHOLE document -- both tracks, every viewer --
// if a single part reports `durationSecs <= 0`, and a zero-tick fragment is
// reachable (two access units sharing a PTS, an audio frame the encoder
// emitted back to back). One millisecond is below anything a player
// meaningfully schedules on and is a far better answer than blanking the
// stream over one degenerate part.
const minDurationSecs = 0.001

// Meta is the session's fixed identity and targets -- everything in
// state.json that does not come from a ring. All four are immutable for a
// session's lifetime (`control.PipelineConfig`), including across the
// watchdog's one allowed restart.
type Meta struct {
	// SessionID must be the UUID the control plane started this session
	// with: the Worker derives the same id itself from (channelId,
	// startedAtMs) and `parseLlState` checks the shape, because it is
	// rendered unescaped into `#EXT-X-PQP-SESSION:`.
	SessionID       string
	ChannelID       string
	PartTargetMs    int
	SegmentTargetMs int
}

// names is one track's file-naming scheme, matching exactly what
// internal/serve.Server answers: the video ring under bare names, the
// audio ring under an "audio-" prefix.
type names struct {
	initURI string
	prefix  string
}

var (
	videoNames = names{initURI: "init.mp4", prefix: ""}
	audioNames = names{initURI: "audio-init.mp4", prefix: "audio-"}
)

func (n names) segment(index int) string { return n.prefix + "seg-" + strconv.Itoa(index) + ".m4s" }

func (n names) part(seq uint32) string {
	return n.prefix + "part-" + strconv.FormatUint(uint64(seq), 10) + ".m4s"
}

// Part is one EXT-X-PART's worth of state.
type Part struct {
	// Index is the part's position within its OWN segment (0-based) --
	// not the CMAF sequence number, which is what URI carries. See the
	// package doc comment, "THE URIS ARE THE ONES THIS BINARY ACTUALLY
	// SERVES".
	Index        int     `json:"index"`
	DurationSecs float64 `json:"durationSecs"`
	Independent  bool    `json:"independent"`
	URI          string  `json:"uri"`
}

// Segment is one segment: sealed (Complete, with a duration and a URI of
// its own) or the one still being assembled (parts only).
type Segment struct {
	MSN      int  `json:"msn"`
	Complete bool `json:"complete"`
	// DurationSecs and URI are present only when Complete -- the Worker's
	// parser refuses an in-progress segment that carries a URI, since
	// there is no sealed object to point at yet.
	DurationSecs    *float64 `json:"durationSecs,omitempty"`
	URI             *string  `json:"uri,omitempty"`
	ProgramDateTime string   `json:"programDateTime"`
	Parts           []Part   `json:"parts"`
}

// PreloadHint names the part the fragmenter has NOT emitted yet.
type PreloadHint struct {
	MSN  int    `json:"msn"`
	Part int    `json:"part"`
	URI  string `json:"uri"`
}

// Track is one rendition's half of the document.
type Track struct {
	InitURI     string       `json:"initUri"`
	Segments    []Segment    `json:"segments"`
	PreloadHint *PreloadHint `json:"preloadHint"`
}

// State is the whole document.
type State struct {
	SessionID          string  `json:"sessionId"`
	ChannelID          string  `json:"channelId"`
	PartTargetMs       int     `json:"partTargetMs"`
	SegmentTargetMs    int     `json:"segmentTargetMs"`
	TargetDurationSecs float64 `json:"targetDurationSecs"`
	// MediaSequence is the VIDEO track's oldest listed segment's MSN --
	// `parseLlState` checks that equality, so it is arithmetic, not a
	// summary. Note it is segments[0].Index, NOT the ring's own
	// baseIndex: those agree only while a session's numbering started at
	// zero, and a watchdog restart resumes a replacement pipeline's
	// segment indices past its predecessor's (see
	// control.PipelineConfig.StartVideoSegmentIndex). The MSNs must match
	// the seg-<n>.m4s names the Worker will fetch back, which are the
	// segment indices.
	MediaSequence int    `json:"mediaSequence"`
	Video         *Track `json:"video"`
	Audio         *Track `json:"audio"`
}

// Build renders state.json for one session. audio may be nil (or simply
// have nothing in it yet): the contract says audio is legitimately absent
// until a stage source has spoken, and the Worker re-derives the audio
// group from THIS document on every master request, so a session that
// starts video-only and later grows audio is picked up automatically.
//
// ok is false when the session cannot be described as an LL playlist at
// all -- no init segment, or no segment with a part in it. The HTTP
// surface turns that into a 404, which the Worker reads as "this party is
// conventional" and retries a few seconds later; emitting a document the
// parser would reject instead would cost an `hlsEdge.llStateFetchFailed`
// on every probe and teach nobody anything.
func Build(meta Meta, video ring.Snapshot, audio *ring.Snapshot) (State, bool) {
	videoTrack, ok := buildTrack(video, videoNames, false)
	if !ok {
		return State{}, false
	}
	state := State{
		SessionID:       meta.SessionID,
		ChannelID:       meta.ChannelID,
		PartTargetMs:    meta.PartTargetMs,
		SegmentTargetMs: meta.SegmentTargetMs,
		MediaSequence:   videoTrack.Segments[0].MSN,
		Video:           videoTrack,
	}
	if audio != nil {
		// A track this package cannot render is simply absent, never a
		// reason to fail the whole document: video-only is a legal LL
		// session, and an audio ring that has not produced a part yet is
		// the ordinary state of every party before somebody speaks.
		if audioTrack, audioOK := buildTrack(*audio, audioNames, true); audioOK {
			state.Audio = audioTrack
		}
	}
	state.PartTargetMs = partTargetMs(meta.PartTargetMs, videoTrack, state.Audio)
	state.TargetDurationSecs = targetDuration(videoTrack, state.Audio, video.TargetSecs, audioTargetSecs(audio))
	return state, true
}

// partTargetMs is what #EXT-X-PART-INF:PART-TARGET is rendered from: the
// configured PART_MS, raised to cover the longest part actually listed.
// Same shape and same reason as targetDuration below, one level down.
//
// A PART-TARGET is a promise about the MAXIMUM part duration (RFC 8216bis
// section 4.4.3.7), and a part may legitimately run past PART_MS in two
// ways. The small one has always been there: a part is cut on the first
// access unit at or past the target, so a 30fps source overshoots by up to
// one frame. The large one arrived with the 2026-09-15 drift fix: a quiet
// source's part now waits for the frame that really ends the gap and
// carries that frame's TRUE duration rather than a guessed one, so a
// Chrome tab share at 1.4 frames/s publishes parts of about a second
// against a 500ms PART_MS. Understating the target there is not a
// cosmetic lie: the edge Worker times its blocking playlist reloads at
// three part targets, so a stale 500ms would hold a viewer's request for
// 1.5s against a part that cannot arrive for a wall second, and time out
// on a stream that is perfectly healthy. Reporting the real figure lets
// that hold widen by itself, with no second configuration knob to keep in
// sync.
func partTargetMs(configured int, tracks ...*Track) int {
	longest := configured
	for _, track := range tracks {
		if track == nil {
			continue
		}
		for _, seg := range track.Segments {
			for _, part := range seg.Parts {
				if ms := int(math.Ceil(part.DurationSecs * 1000)); ms > longest {
					longest = ms
				}
			}
		}
	}
	if longest <= 0 {
		// parseLlState refuses a document whose partTargetMs is not a
		// positive integer, and refusing the whole document stalls every
		// viewer. A caller that configured nothing sensible gets a
		// millisecond rather than a blank stream.
		longest = 1
	}
	return longest
}

// buildTrack renders one rendition. allIndependent is the audio override:
// RFC 8216bis recommends marking audio parts independent because there is
// usually no inter-part reference to break, and the audio fragmenter's own
// IsSegmentStart flag (which is what the ring records) is true only on a
// segment boundary, so taking it literally would understate independence
// for every other audio part.
func buildTrack(snap ring.Snapshot, n names, allIndependent bool) (*Track, bool) {
	if !snap.HasInit || len(snap.Segments) == 0 || snap.Timescale == 0 {
		return nil, false
	}
	track := &Track{InitURI: n.initURI}
	for _, seg := range snap.Segments {
		if len(seg.Parts) == 0 {
			// Unreachable through Ring.Push (a segment is opened BY its
			// first part), and refused rather than rendered: a segment
			// with no parts breaks the "live edge has something to play"
			// rule if it is last, and renders an EXTINF with no media if
			// it is not.
			return nil, false
		}
		out := Segment{
			MSN:             seg.Index,
			Complete:        seg.Sealed,
			ProgramDateTime: seg.OpenedAt.UTC().Format(pdtLayout),
		}
		var totalTicks uint64
		for i, p := range seg.Parts {
			totalTicks += uint64(p.DurationTicks)
			out.Parts = append(out.Parts, Part{
				Index:        i,
				DurationSecs: secs(uint64(p.DurationTicks), snap.Timescale),
				Independent:  allIndependent || p.Independent,
				URI:          n.part(p.Seq),
			})
		}
		if seg.Sealed {
			d := secs(totalTicks, snap.Timescale)
			uri := n.segment(seg.Index)
			out.DurationSecs = &d
			out.URI = &uri
		}
		track.Segments = append(track.Segments, out)
	}
	// MSNs must be strictly increasing and contiguous -- the fragmenter
	// only ever increments, so this is a check on that invariant, not a
	// repair: a gap would be rejected by the Worker's parser anyway, and
	// finding out here (404, fall back to conventional) beats finding out
	// there (llStateFetchFailed on every poll).
	for i := 1; i < len(track.Segments); i++ {
		if track.Segments[i].MSN != track.Segments[i-1].MSN+1 {
			return nil, false
		}
	}
	// Only the LAST segment may be incomplete.
	for i := 0; i < len(track.Segments)-1; i++ {
		if !track.Segments[i].Complete {
			return nil, false
		}
	}
	if snap.HaveParts {
		last := track.Segments[len(track.Segments)-1]
		hint := PreloadHint{MSN: last.MSN, Part: len(last.Parts), URI: n.part(snap.NextPartSeq)}
		if last.Complete {
			// A sealed last segment means the next part opens the next
			// segment: part 0 of MSN+1. The Worker's parser computes the
			// same two cases and rejects anything else.
			hint = PreloadHint{MSN: last.MSN + 1, Part: 0, URI: n.part(snap.NextPartSeq)}
		}
		track.PreloadHint = &hint
	}
	return track, true
}

func audioTargetSecs(audio *ring.Snapshot) int {
	if audio == nil {
		return 0
	}
	return audio.TargetSecs
}

// targetDuration is what #EXT-X-TARGETDURATION is rendered from. The ring
// already keeps a running ceil of the longest segment it ever sealed, and
// that is the primary source -- but this also takes a ceil over the
// segments actually LISTED, on both tracks, because `parseLlState` rejects
// the entire document when any complete segment's duration reaches the
// rendered target plus half a second. A target that is too small by a
// second stalls every viewer; a target that is a second too large costs a
// player a slightly more conservative hold-back and nothing else. The
// floor of 1 is the tag's own grammar (a positive integer).
func targetDuration(video *Track, audio *Track, videoTargetSecs, audioTgtSecs int) float64 {
	longest := 1.0
	if float64(videoTargetSecs) > longest {
		longest = float64(videoTargetSecs)
	}
	if float64(audioTgtSecs) > longest {
		longest = float64(audioTgtSecs)
	}
	for _, track := range []*Track{video, audio} {
		if track == nil {
			continue
		}
		for _, seg := range track.Segments {
			if seg.DurationSecs == nil {
				continue
			}
			if c := math.Ceil(*seg.DurationSecs); c > longest {
				longest = c
			}
		}
	}
	return longest
}

// secs converts ticks at timescale into seconds, rounded to milliseconds
// so the same ring state always serializes to the same bytes (a golden
// file, and two captures a human wants to diff), and floored at
// minDurationSecs.
func secs(ticks uint64, timescale uint32) float64 {
	if timescale == 0 {
		return minDurationSecs
	}
	v := math.Round(float64(ticks)/float64(timescale)*1000) / 1000
	if v < minDurationSecs {
		return minDurationSecs
	}
	return v
}
