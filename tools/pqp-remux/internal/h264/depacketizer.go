// Package h264 turns a stream of RTP packets carrying RFC 6184 H.264
// (single NAL, STAP-A or FU-A) into access units: the boundary CMAF parts
// and segments are cut on. It never decodes a frame; it only depayloads and
// classifies NAL types.
package h264

import (
	"errors"
	"time"

	"github.com/pion/rtp/codecs"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// ClockRate is the RTP clock rate WebRTC uses for H.264 video (RFC 6184
// names no rate; 90 kHz is what every browser and LiveKit's SFU send, the
// same rate section 3 of the plan and every existing HLS ladder assume).
const ClockRate = 90000

// AccessUnit is every NAL that shared one RTP timestamp, reassembled in
// AVCC (4-byte length prefixed) form so it drops straight into a CMAF
// sample: exactly what pion's H264Packet.Unmarshal(..., IsAVC: true)
// produces per packet, concatenated across the packets of one frame.
type AccessUnit struct {
	// PTS is the unwrapped (never wraps across a session) 90 kHz media
	// timestamp carried by the RTP packets that made up this AU.
	PTS int64
	// Arrived is the wall-clock time the AU's marker packet was pushed,
	// used only for IDR-cadence logging (section 3 of the plan); it is
	// never fed into the muxer's timing.
	Arrived time.Time
	// AVCC is the AU's NAL units, each 4-byte length prefixed, in arrival
	// order. This is exactly one CMAF sample's payload.
	AVCC []byte
	// Units mirrors AVCC, parsed, for callers that want NAL-level detail
	// without re-parsing (nal.ParseAVCC(AVCC) would return the same thing).
	Units []nal.Unit
	// IsIDR is true when the AU contains an IDR slice: this AU may start a
	// segment.
	IsIDR bool
	// SPS/PPS carry the raw NAL (header byte included, no length prefix)
	// the last time this AU carried one, for building/refreshing avcC.
	SPS []byte
	PPS []byte
}

// Bytes returns the number of sample bytes (AVCC length prefixes included)
// in the AU, the size the IDR log reports.
func (au *AccessUnit) Bytes() int { return len(au.AVCC) }

var errNoPackets = errors.New("h264: Push called with an empty RTP payload")

// errTimestampChangedMidAU is returned when a packet's RTP timestamp
// differs from the access unit currently open: the previous AU's marker
// packet was lost, so that AU is discarded (see Push's doc comment) rather
// than having this packet's data merged into it.
var errTimestampChangedMidAU = errors.New("h264: RTP timestamp changed before a marker packet closed the access unit; it was discarded")

// errAccessUnitTooLarge is returned (and the offending AU discarded, never
// merged into the next one) when an access unit's accumulated bytes exceed
// maxAccessUnitBytes without a marker packet ever arriving. A legitimate
// WebRTC screen-share frame, even a 4K IDR split across many slices, comes
// nowhere close to this; hitting it means either a stuck FU-A fragment or a
// publisher withholding the marker bit, and the alternative — appending
// forever — is unbounded memory growth from remote input.
var errAccessUnitTooLarge = errors.New("h264: access unit exceeded the size bound with no marker packet; discarded")

// maxAccessUnitBytes bounds how much a single access unit may accumulate
// before Push gives up on it. 8 MiB is generous: pqp's screen-share
// pipeline runs well under 4K, and even a very large keyframe is a small
// fraction of this.
const maxAccessUnitBytes = 8 << 20

// Depacketizer reassembles access units from a single H.264 RTP stream. It
// is not safe for concurrent use; one instance per subscribed track.
type Depacketizer struct {
	inner codecs.H264Packet

	buf   []byte
	units []nal.Unit

	haveTimestamp bool
	lastRaw       uint32
	extended      int64
	auExtended    int64
	auStarted     bool

	pendingSPS []byte
	pendingPPS []byte
}

// NewDepacketizer returns a depacketizer configured to emit AVCC (length
// prefixed) NAL units, which is what the CMAF muxer's mdat samples want.
func NewDepacketizer() *Depacketizer {
	d := &Depacketizer{}
	d.inner.IsAVC = true
	return d
}

// Push feeds one RTP packet belonging to this track: its H.264 payload, its
// RTP timestamp, and whether the RTP marker bit was set (RFC 6184 says the
// marker bit closes an access unit). It returns the completed AccessUnit
// when the packet finishes one, and nil while a frame is still assembling.
//
// A malformed packet (a truncated FU-A, an unsupported NAL type) returns an
// error and drops only that packet's contribution; the depacketizer keeps
// accumulating so one bad packet does not wedge the stream.
//
// Two recovery rules protect the AU boundary itself, both signaled by a
// returned error with a nil AccessUnit (never by silently merging data
// across a boundary that should not have been crossed):
//
//   - If this packet's timestamp differs from the AU currently open, the
//     previous AU's marker packet was lost. The incomplete AU is discarded
//     (not flushed, and never merged with this packet's data) before this
//     packet starts a new one — merging would produce one CMAF sample
//     spanning two pictures, stamped with the first picture's PTS.
//   - If an AU's accumulated bytes exceed maxAccessUnitBytes with no
//     marker ever arriving, it is discarded rather than grown forever.
func (d *Depacketizer) Push(payload []byte, rtpTimestamp uint32, marker bool) (*AccessUnit, error) {
	if len(payload) == 0 {
		return nil, errNoPackets
	}

	var timestampErr error
	if d.auStarted && d.haveTimestamp && rtpTimestamp != d.lastRaw {
		d.discardIncompleteAU()
		timestampErr = errTimestampChangedMidAU
	}

	d.advanceClock(rtpTimestamp)
	if !d.auStarted {
		d.auExtended = d.extended
		d.auStarted = true
	}

	out, err := d.inner.Unmarshal(payload)
	if err != nil {
		// A malformed fragment can leave pion holding half a NAL; never let
		// that tail leak into the next one.
		d.resetReassembly()
		// Keep the AU open: a single dropped/malformed packet should not
		// discard everything already assembled for this frame.
		if !marker {
			return nil, firstErr(timestampErr, err)
		}
		// Fall through so a marker packet still closes and emits whatever
		// was assembled before the bad packet, rather than wedging the
		// depacketizer open forever.
	} else if len(out) > 0 {
		units, perr := nal.ParseAVCC(out)
		if perr == nil {
			for _, u := range units {
				switch {
				case u.IsSPS():
					// Copy: the caller may hold this AU past the next Push,
					// and out's backing array is reused by codecs.H264Packet.
					d.setSPS(append([]byte(nil), u.Payload...))
				case u.IsPPS():
					d.setPPS(append([]byte(nil), u.Payload...))
				}
			}
			d.units = append(d.units, units...)
		}
		d.buf = append(d.buf, out...)

		if len(d.buf) > maxAccessUnitBytes {
			d.discardIncompleteAU()
			return nil, firstErr(timestampErr, errAccessUnitTooLarge)
		}
	}

	if !marker {
		return nil, firstErr(timestampErr, err)
	}

	au := d.flush()
	return au, firstErr(timestampErr, err)
}

// discardIncompleteAU drops whatever has been accumulated for the
// currently-open access unit without emitting it. pendingSPS/pendingPPS
// are session-level state, not tied to one AU, and survive.
func (d *Depacketizer) discardIncompleteAU() {
	d.buf = nil
	d.units = nil
	d.auStarted = false
	d.resetReassembly()
}

// resetReassembly drops any FU-A fragments pion is still holding. pion's
// H264Packet appends every FU-A fragment to one buffer and only clears it
// on the fragment that carries the end bit; a fragment with the START bit
// does not reset it. So when an access unit is discarded mid-fragment (the
// end fragment was lost, or the timestamp jumped), the next fragmented NAL
// is glued onto the stale tail and reaches the decoder as a slice with
// garbage inside it: libav says "mb_type ... in P slice too large", Chrome
// on macOS says MEDIA_ERR_DECODE -12909 and the media element is dead for
// good. Measured 2026-09-16 on a live party with ordinary packet loss. pion
// exposes no reset, so a fresh packetizer is the only way to clear it.
func (d *Depacketizer) resetReassembly() {
	d.inner = codecs.H264Packet{IsAVC: true}
}

// firstErr returns the first non-nil error, so a caller sees the boundary
// recovery error (timestamp change / oversized AU) even when the
// underlying Unmarshal also failed on the same packet.
func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// pendingSPS/pendingPPS survive across access units: SPS/PPS are typically
// sent once (or on an IDR cadence, not every frame), and the muxer's init
// segment needs whichever pair was seen most recently even if this AU did
// not itself carry them.
func (d *Depacketizer) setSPS(b []byte) { d.pendingSPS = b }
func (d *Depacketizer) setPPS(b []byte) { d.pendingPPS = b }

func (d *Depacketizer) flush() *AccessUnit {
	au := &AccessUnit{
		PTS:     d.auExtended,
		Arrived: time.Now(),
		AVCC:    d.buf,
		Units:   d.units,
		SPS:     d.pendingSPS,
		PPS:     d.pendingPPS,
	}
	for _, u := range au.Units {
		if u.IsIDR() {
			au.IsIDR = true
			break
		}
	}

	d.buf = nil
	d.units = nil
	d.auStarted = false
	return au
}

// advanceClock unwraps the 32-bit RTP timestamp into a monotonically
// increasing int64 so a `tfdt` base decode time never wraps mid-session.
// Packets within one AU share a timestamp, so this only advances on the
// first packet of a new frame.
func (d *Depacketizer) advanceClock(raw uint32) {
	if !d.haveTimestamp {
		d.haveTimestamp = true
		d.lastRaw = raw
		d.extended = 0
		return
	}
	if raw == d.lastRaw {
		return
	}
	delta := int32(raw - d.lastRaw) // wraparound-safe two's complement diff
	d.extended += int64(delta)
	d.lastRaw = raw
}
