// Package ring holds a session's CMAF output in memory (a tmpfs stand-in
// for this local test surface, see the plan's §1 note that production
// parts are served from tmpfs+Caddy, not R2) and renders the conventional
// (not LL) media playlist L1.2 asks for. LL playlist tags and blocking
// reload are L2.x.
package ring

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
)

// part is one fragment (moof+mdat) inside a segment.
type part struct {
	seq           uint32
	bytes         []byte
	durationTicks uint32
	// independent is the pipeline's own claim that this part's first
	// frame can be decoded without any earlier part of the same segment
	// -- pipeline.Fragment.IsSegmentStart, i.e. "this part starts on an
	// IDR". It is recorded here rather than inferred later because the
	// ring is the only place that still knows which fragment carried it:
	// Snapshot hands it straight to internal/llstate, which renders it
	// as EXT-X-PART's INDEPENDENT=YES through the edge Worker. Never
	// guessed from position -- an audio ring's parts are ALL
	// independent, which is llstate's own per-track override, not
	// something this field pretends to know.
	independent bool
}

// segment is every part between two segment boundaries, i.e. one seg-<n>.m4s
// file once sealed. Sealed means a later fragment opened the next segment;
// until then a segment is still being appended to.
type segment struct {
	index  int
	parts  []part
	sealed bool
	// openedAt is the wall clock the moment this segment's FIRST part was
	// pushed -- the anchor internal/llstate renders as
	// #EXT-X-PROGRAM-DATE-TIME. It is the arrival time of the media, not
	// a presentation timestamp derived from the RTP clock: this process
	// has no absolute media clock to map PTS onto (the publisher's own
	// epoch is not knowable from RTP alone), and a viewer's
	// latency-from-PDT measurement wants the time the box saw the frame
	// anyway. Stamped once per segment, never per part, so every part of
	// one segment shares the segment's anchor exactly the way HLS
	// expects.
	openedAt time.Time
}

func (s *segment) bytes() []byte {
	var out []byte
	for _, p := range s.parts {
		out = append(out, p.bytes...)
	}
	return out
}

func (s *segment) durationTicks() uint64 {
	var total uint64
	for _, p := range s.parts {
		total += uint64(p.durationTicks)
	}
	return total
}

// Ring is a fixed-capacity, oldest-evicted-first buffer of a session's CMAF
// output: the init segment (built once), every part by its global CMAF
// sequence number, and segments grouped for the media playlist.
type Ring struct {
	mu sync.RWMutex

	timescale   uint32
	maxSegments int

	init []byte

	segments   []*segment // index 0 is the oldest retained segment
	seqToPart  map[uint32]part
	baseIndex  int // segment index of segments[0], for #EXT-X-MEDIA-SEQUENCE
	targetSecs int

	// lastSeq/haveSeq remember the newest part sequence number ever
	// pushed (NOT merely the newest retained one -- eviction drops parts
	// from seqToPart but must never rewind what the next part will be
	// called). Snapshot reports lastSeq+1 as NextPartSeq, which is the
	// file name the preload hint points at: the part the fragmenter has
	// not emitted yet.
	lastSeq uint32
	haveSeq bool
	now     func() time.Time
}

// New returns an empty Ring. maxSegments is RING_SEGMENTS; timescale must
// match the Fragmenter's Config.Timescale (ticks/second) so playlist
// durations come out in real seconds.
func New(maxSegments int, timescale uint32) *Ring {
	if maxSegments < 1 {
		maxSegments = 1
	}
	return &Ring{
		maxSegments: maxSegments,
		timescale:   timescale,
		seqToPart:   make(map[uint32]part),
		now:         time.Now,
	}
}

// SetInit stores the session's init segment (ftyp+moov). Called once, as
// soon as the first SPS/PPS pair is known.
func (r *Ring) SetInit(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.init = b
}

// Init returns the init segment, or (nil, false) before SetInit.
func (r *Ring) Init() ([]byte, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.init == nil {
		return nil, false
	}
	return r.init, true
}

// Push records one fragment from the pipeline. A fragment whose
// IsSegmentStart is true seals the previous segment (if any) and opens
// SegmentIndex; eviction of the oldest retained segment happens here, the
// moment a new one is opened, never mid-segment.
func (r *Ring) Push(f *pipeline.Fragment) {
	r.mu.Lock()
	defer r.mu.Unlock()

	p := part{seq: f.SequenceNumber, bytes: f.Bytes, durationTicks: f.DurationTicks, independent: f.IsSegmentStart}
	r.seqToPart[f.SequenceNumber] = p
	if !r.haveSeq || f.SequenceNumber > r.lastSeq {
		r.lastSeq = f.SequenceNumber
		r.haveSeq = true
	}

	if f.IsSegmentStart || len(r.segments) == 0 {
		if len(r.segments) > 0 {
			last := r.segments[len(r.segments)-1]
			last.sealed = true
			r.updateTargetDuration(last)
		}
		r.segments = append(r.segments, &segment{index: f.SegmentIndex, openedAt: r.now()})
		for len(r.segments) > r.maxSegments {
			evicted := r.segments[0]
			for _, ep := range evicted.parts {
				delete(r.seqToPart, ep.seq)
			}
			r.segments = r.segments[1:]
			r.baseIndex++
		}
	}

	cur := r.segments[len(r.segments)-1]
	cur.parts = append(cur.parts, p)
}

func (r *Ring) updateTargetDuration(s *segment) {
	secs := int(math.Ceil(float64(s.durationTicks()) / float64(r.timescale)))
	if secs > r.targetSecs {
		r.targetSecs = secs
	}
}

// Part returns one fragment's raw bytes by its global CMAF sequence
// number (the file the server names part-<seq>.m4s).
func (r *Ring) Part(seq uint32) ([]byte, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.seqToPart[seq]
	if !ok {
		return nil, false
	}
	return p.bytes, true
}

// Segment returns one full segment's bytes (its parts concatenated in
// order, a valid standalone fragmented-mp4 byte stream) by segment index,
// the file the server names seg-<n>.m4s. It is served even while still
// open (not yet sealed): a conventional HLS player only ever requests a
// segment once the playlist lists it, which Playlist only does once sealed,
// but the LL-facing part endpoints (L2.x, not this file) want the partial
// bytes available immediately.
func (r *Ring) Segment(index int) ([]byte, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s := r.findSegment(index)
	if s == nil {
		return nil, false
	}
	return s.bytes(), true
}

func (r *Ring) findSegment(index int) *segment {
	for _, s := range r.segments {
		if s.index == index {
			return s
		}
	}
	return nil
}

// Playlist renders a conventional (non-LL) HLS media playlist listing every
// sealed segment currently retained, oldest first. An unsealed (still
// live) segment is never listed: HLS requires EXTINF's duration to be the
// segment's true duration, which is only known once it is sealed.
func (r *Ring) Playlist() string { return r.PlaylistWithURIPrefix("") }

// PlaylistWithURIPrefix is Playlist, but every URI it emits (the init
// segment and each segment) is prefixed with prefix. internal/serve
// serves a second, independent ring for the audio rendition on routes
// named "audio-init.mp4"/"audio-seg-<n>.m4s" (see its own doc comment),
// so its playlist must advertise those same prefixed names -- calling
// plain Playlist() there would tell a player to fetch "/init.mp4" and
// "/seg-<n>.m4s", which route back to the VIDEO ring instead, and the
// advertised audio rendition would either 404 or silently play the wrong
// track. Video's own call sites keep using Playlist() (prefix ""), which
// keeps every existing test and this method's on-disk file names
// unchanged.
func (r *Ring) PlaylistWithURIPrefix(prefix string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:7\n")
	target := r.targetSecs
	if target < 1 {
		target = 1
	}
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", target)
	fmt.Fprintf(&b, "#EXT-X-MEDIA-SEQUENCE:%d\n", r.baseIndex)
	fmt.Fprintf(&b, "#EXT-X-MAP:URI=\"%sinit.mp4\"\n", prefix)

	for _, s := range r.segments {
		if !s.sealed {
			continue
		}
		durSecs := float64(s.durationTicks()) / float64(r.timescale)
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n", durSecs)
		fmt.Fprintf(&b, "%sseg-%d.m4s\n", prefix, s.index)
	}
	return b.String()
}

// SetClock replaces the wall clock this Ring stamps segment.openedAt with.
// Intended for tests that need a deterministic #EXT-X-PROGRAM-DATE-TIME;
// production never calls it. Must be called before the first Push.
func (r *Ring) SetClock(now func() time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now != nil {
		r.now = now
	}
}

// PartSnapshot is one part as internal/llstate sees it: enough to render
// an EXT-X-PART line (duration, independence) and to name the file this
// package's HTTP surface serves it from (part-<Seq>.m4s), and nothing
// else -- deliberately no bytes, so a snapshot is cheap to take on every
// state.json request and holds no reference to the ring's buffers.
type PartSnapshot struct {
	Seq           uint32
	DurationTicks uint32
	Independent   bool
}

// SegmentSnapshot is one segment as internal/llstate sees it. Sealed is
// the difference between a segment that gets an #EXTINF line and the one
// still being assembled, which gets only its parts -- see
// PlaylistWithURIPrefix, which applies the same rule to the conventional
// playlist.
type SegmentSnapshot struct {
	Index    int
	Sealed   bool
	OpenedAt time.Time
	Parts    []PartSnapshot
}

// Snapshot is a consistent, allocation-copied view of everything
// internal/llstate needs to render state.json for one track: taken under
// the ring's own lock so a concurrent Push can never be observed half
// applied (a segment listed with the part count it had a moment before the
// duration total was updated, say), and holding no slice the ring itself
// keeps mutating afterwards.
type Snapshot struct {
	Timescale uint32
	// TargetSecs is the ring's running ceil(longest sealed segment), the
	// same number PlaylistWithURIPrefix renders as
	// #EXT-X-TARGETDURATION. Zero before anything has been sealed;
	// llstate applies the floor of 1 the tag's grammar requires.
	TargetSecs int
	HasInit    bool
	// NextPartSeq is the sequence number the fragmenter will give the
	// NEXT part it emits -- the file an EXT-X-PRELOAD-HINT points at.
	// Valid only when HaveParts is true.
	NextPartSeq uint32
	HaveParts   bool
	Segments    []SegmentSnapshot
}

// Snapshot takes one. Oldest segment first, matching the order
// PlaylistWithURIPrefix lists them and the order state.json's own contract
// requires (`tools/hls-edge/src/ll-state.js`: MSNs strictly increasing and
// contiguous, at most the LAST segment incomplete).
func (r *Ring) Snapshot() Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()

	snap := Snapshot{
		Timescale:   r.timescale,
		TargetSecs:  r.targetSecs,
		HasInit:     r.init != nil,
		NextPartSeq: r.lastSeq + 1,
		HaveParts:   r.haveSeq,
	}
	for _, s := range r.segments {
		seg := SegmentSnapshot{Index: s.index, Sealed: s.sealed, OpenedAt: s.openedAt}
		for _, p := range s.parts {
			seg.Parts = append(seg.Parts, PartSnapshot{
				Seq:           p.seq,
				DurationTicks: p.durationTicks,
				Independent:   p.independent,
			})
		}
		snap.Segments = append(snap.Segments, seg)
	}
	return snap
}
