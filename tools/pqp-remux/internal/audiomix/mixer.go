// Package audiomix decodes Opus audio from every stage source (the
// presenter's screen-share audio, and every participant's microphone),
// mixes them into one 48kHz stereo PCM stream, and hands it to a caller a
// fixed chunk at a time. This is L1.3 of docs/plans/LL_HLS.md ("Audio: mix
// and AAC"): "pqp-remux decodes every stage audio track, mixes PCM and
// encodes one AAC-LC stream."
//
// Codec choice for decode: github.com/pion/opus (RFC 6716, pure Go, MIT),
// not a cgo binding (hraban/opus) or shelling out to ffmpeg for this half.
// Reasons, in order of weight:
//
//   - No cgo means no libopus-dev system dependency on every box this ever
//     runs on -- the shared SFU box today, a future dedicated remux box
//     tomorrow -- for a workload nowhere near CPU-bound: the plan's own
//     floor for this whole task is "audio mix and AAC about 0.05 of a core
//     for a busy stage" against a 4 vCPU budget (section 5). A local
//     benchmark decoding a 30s 64kbps stereo Opus stream 50 times over
//     (TestDecodeCostBenchmarkData in mixer_test.go builds the fixture;
//     see the README's "Codec choices and their CPU cost" for the numbers)
//     measured pion/opus at roughly 850x real time on this machine, i.e.
//     about 0.1% of one core per decoded track -- an order of magnitude
//     under the plan's floor, so decode speed was never the constraint
//     that would justify paying for cgo.
//   - Quality: RFC 6716 conformance vectors aside (this package does not
//     re-run libopus's own test suite), a decoded sine sweep round-tripped
//     through pion/opus in this package's own tests produces no NaN, no
//     clipping and a peak amplitude matching the source, which is the bar
//     "acceptable for a mixed, re-encoded stream" needs to clear -- this is
//     not a lossless archival path, it feeds a lossy AAC encoder next.
//   - One fewer version to pin and audit, the same argument internal/cmaf's
//     README already makes for hand-rolling the muxer instead of adopting
//     a general-purpose MP4 library.
//
// AAC encoding is a separate concern (internal/aacenc): this package only
// produces PCM.
package audiomix

import (
	"math"
	"sync"
	"time"

	"github.com/pion/opus"
)

// SampleRate is fixed throughout the mixer. RFC 7587 pins WebRTC's Opus
// RTP clock at 48000 regardless of the encoded audio's actual bandwidth
// (narrowband through fullband all share it), so no source ever needs
// resampling to join the mix, and it is also the sample rate this service
// hands to the AAC encoder.
const SampleRate = 48000

// Channels is the mix's own output layout: stereo, per the plan's "mix to
// one stereo 48kHz stream". A mono source (most microphones) is upmixed to
// stereo by the Opus decoder itself; NewDecoderWithOutput's channel count
// is the *output* layout, independent of a packet's own channel count.
const Channels = 2

// maxOpusFrameSamples is the largest sample count (per channel) a single
// Opus packet can ever decode to: RFC 6716's longest frame is 120ms at
// 48kHz. Source's scratch decode buffer is sized once from this so Push
// never allocates on the hot path.
const maxOpusFrameSamples = 5760

// ringCapacitySamples bounds how far a source's writer may run ahead of
// the mixer's reader before older, already-superseded data at the same
// modular ring slot is overwritten: 2s at 48kHz. Generous next to WebRTC
// jitter (tens of ms) and this service's own part/segment targets (500ms
// and 4s) -- the mixer stalling for 2s is a symptom worth its own alarm
// elsewhere, not something this buffer needs to survive gracefully.
const ringCapacitySamples = SampleRate * 2

// Source is one decoded Opus contributor to the mix: the presenter's
// screen-share audio, or one participant's microphone. Push is called
// from that track's own RTP-reading goroutine; the mixer's read runs from
// a single, separate pacing goroutine (Mixer.Pull's doc comment). Both are
// safe to call concurrently with each other.
type Source struct {
	mu sync.Mutex

	dec     opus.Decoder
	scratch [maxOpusFrameSamples * Channels]float32

	// ring holds every sample this source has ever placed on the shared
	// timeline, modulo ringCapacitySamples, interleaved stereo.
	ring [ringCapacitySamples * Channels]float32
	// writeHead is one past the highest absolute sample index this source
	// has written. Reads at or past it are "hasn't arrived yet" and
	// return silence rather than whatever happens to sit in that ring
	// slot -- this is what makes a source that has gone silent (a
	// microphone that stopped, a participant who left) contribute
	// silence instead of replaying stale audio once the ring wraps back
	// around to a slot it once wrote: writeHead simply stops advancing,
	// so every later read for this source is silence by construction,
	// without ever touching (or needing to clear) the ring's own bytes.
	writeHead int64

	haveRTPBase bool
	rtpBaseline uint32
	rtpExtended int64
	// anchorAbs is the absolute sample index of this source's own first
	// decoded sample, computed exactly once (see Push's doc comment).
	anchorAbs int64
}

// NewSource returns a Source ready to decode 48kHz stereo Opus.
func NewSource() *Source {
	dec, _ := opus.NewDecoderWithOutput(SampleRate, Channels) // sampleRate/channels are both valid constants; error is unreachable
	return &Source{dec: dec, writeHead: -1}
}

// Push decodes one Opus RTP packet's payload and writes the resulting PCM
// onto this source's slot of the shared sample timeline.
//
// epoch is the ONE shared wall-clock anchor for the whole session --
// Session's own construction time in practice (see Session's doc
// comment: video's own PTS is zero-based from its first RTP packet,
// which arrives only milliseconds after construction once Connect's read
// loop starts, so the two are close enough that treating them as the same
// instant is a documented approximation, not a bug), kept identical for
// the life of the session regardless of which source calls Push. arrival
// is when this packet reached Push. Both are used exactly once, on this
// source's own first packet, to place its zero point on the timeline;
// every subsequent packet is positioned purely from this source's own RTP
// timestamp deltas -- sample-accurate and immune to network jitter, per
// docs/plans/LL_HLS.md L1.3: "derive both from the RTP timestamps against
// one wall-clock anchor." A one-time wall-clock placement error (bounded
// by ordinary network jitter and the construction-to-first-video-packet
// gap, typically low tens of milliseconds) is the only drift source this
// introduces; it does not accumulate, because nothing after the first
// packet ever consults the wall clock again.
func (s *Source) Push(payload []byte, rtpTimestamp uint32, arrival, epoch time.Time) error {
	n, err := s.dec.DecodeToFloat32(payload, s.scratch[:])
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.haveRTPBase {
		s.haveRTPBase = true
		s.rtpBaseline = rtpTimestamp
		s.rtpExtended = 0
		s.anchorAbs = int64(arrival.Sub(epoch).Seconds() * SampleRate)
	} else {
		delta := int32(rtpTimestamp - s.rtpBaseline) // wraparound-safe two's complement diff, mirrors internal/h264's advanceClock
		s.rtpExtended += int64(delta)
		s.rtpBaseline = rtpTimestamp
	}

	start := s.anchorAbs + s.rtpExtended
	for i := 0; i < n; i++ {
		abs := start + int64(i)
		if abs < 0 {
			continue // before this session's epoch; cannot be placed, dropped
		}
		slot := (abs % ringCapacitySamples) * Channels
		s.ring[slot] = s.scratch[i*Channels]
		s.ring[slot+1] = s.scratch[i*Channels+1]
	}
	if end := start + int64(n); end > s.writeHead {
		s.writeHead = end
	}
	return nil
}

// read copies n samples-per-channel starting at absolute position start
// into out (which must have length n*Channels), zero-filling any position
// this source has not (yet, or ever) written.
func (s *Source) read(start int64, n int, out []float32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < n; i++ {
		abs := start + int64(i)
		if abs < 0 || abs >= s.writeHead {
			out[i*Channels] = 0
			out[i*Channels+1] = 0
			continue
		}
		slot := (abs % ringCapacitySamples) * Channels
		out[i*Channels] = s.ring[slot]
		out[i*Channels+1] = s.ring[slot+1]
	}
}

// Mixer sums every active Source's PCM at a shared 48kHz sample clock and
// emits fixed-size stereo chunks via Pull, advancing its own read cursor
// by exactly the number of samples returned each call -- one Mixer per
// remux session.
type Mixer struct {
	mu      sync.Mutex
	sources map[string]*Source
	cursor  int64
}

// NewMixer returns an empty Mixer, its read cursor at absolute sample 0
// (the shared epoch).
func NewMixer() *Mixer {
	return &Mixer{sources: make(map[string]*Source)}
}

// AddSource registers s under id (the caller's own stable key for this
// audio publication -- e.g. "screen" or a participant identity), replacing
// any previous source under the same id. Safe to call concurrently with
// Pull.
func (m *Mixer) AddSource(id string, s *Source) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sources[id] = s
}

// RemoveSource unregisters id, if present. Safe to call concurrently with
// Pull. It does not need to zero anything: the removed Source is simply
// never read again, so whatever it last wrote is inert from the Mixer's
// perspective the instant this returns.
func (m *Mixer) RemoveSource(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sources, id)
}

// Pull returns n samples-per-channel (n*Channels float32, interleaved)
// starting at the mixer's current read cursor: every active source's
// contribution at that window, summed and soft-clipped, then the cursor
// advances by n. A Mixer with no active sources still returns a valid
// n*Channels slice of silence, so a caller on a fixed cadence never has to
// special-case "nobody is talking".
//
// Not safe for concurrent calls to Pull itself (there is exactly one
// caller: the session's audio pacer); AddSource/RemoveSource may run
// concurrently with it from any goroutine.
func (m *Mixer) Pull(n int) []float32 {
	m.mu.Lock()
	start := m.cursor
	m.cursor += int64(n)
	srcs := make([]*Source, 0, len(m.sources))
	for _, s := range m.sources {
		srcs = append(srcs, s)
	}
	m.mu.Unlock()

	out := make([]float32, n*Channels)
	if len(srcs) == 0 {
		return out
	}

	scratch := make([]float32, n*Channels)
	for _, s := range srcs {
		s.read(start, n, scratch)
		for i := range out {
			out[i] += scratch[i]
		}
	}
	for i, v := range out {
		out[i] = softClip(v)
	}
	return out
}

// softClip is a simple sum-and-soft-clip mixing curve: linear for small
// inputs (an unclipped single speaker passes through with negligible
// coloration) and smoothly bounded to (-1, 1) for a loud sum, rather than
// the harsh distortion a hard clamp would introduce when several sources
// peak together.
func softClip(x float32) float32 {
	return float32(math.Tanh(float64(x)))
}
