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

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
)

// part is one fragment (moof+mdat) inside a segment.
type part struct {
	seq           uint32
	bytes         []byte
	durationTicks uint32
}

// segment is every part between two segment boundaries, i.e. one seg-<n>.m4s
// file once sealed. Sealed means a later fragment opened the next segment;
// until then a segment is still being appended to.
type segment struct {
	index  int
	parts  []part
	sealed bool
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

	p := part{seq: f.SequenceNumber, bytes: f.Bytes, durationTicks: f.DurationTicks}
	r.seqToPart[f.SequenceNumber] = p

	if f.IsSegmentStart || len(r.segments) == 0 {
		if len(r.segments) > 0 {
			last := r.segments[len(r.segments)-1]
			last.sealed = true
			r.updateTargetDuration(last)
		}
		r.segments = append(r.segments, &segment{index: f.SegmentIndex})
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
func (r *Ring) Playlist() string {
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
	b.WriteString("#EXT-X-MAP:URI=\"init.mp4\"\n")

	for _, s := range r.segments {
		if !s.sealed {
			continue
		}
		durSecs := float64(s.durationTicks()) / float64(r.timescale)
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n", durSecs)
		fmt.Fprintf(&b, "seg-%d.m4s\n", s.index)
	}
	return b.String()
}
