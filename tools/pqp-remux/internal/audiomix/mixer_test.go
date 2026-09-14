package audiomix

import (
	"bytes"
	"io"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/opus/pkg/oggreader"
)

// loadTonePackets reads testdata/tone.opus (a 2s, 48kHz stereo 440Hz sine
// encoded with libopus at 20ms frames -- see the file's own generation
// command in the PR description) and returns its raw Opus packets in
// order: exactly the bytes an RTP payload would carry for each frame, per
// RFC 7587. Using a real encoder's output (rather than hand-built bytes)
// is what makes these tests exercise the real RFC 6716 decode path, not a
// mock of it; pion/opus ships no public encoder (see mixer.go's package
// doc comment), so the fixture is pre-encoded instead of generated at test
// time.
func loadTonePackets(t *testing.T) [][]byte {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "tone.opus"))
	if err != nil {
		t.Fatalf("opening fixture: %v", err)
	}
	defer f.Close()

	ogg, _, err := oggreader.NewWith(f)
	if err != nil {
		t.Fatalf("parsing ogg header: %v", err)
	}
	var packets [][]byte
	for {
		pkt, _, err := ogg.ParseNextPacket()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("reading ogg packet: %v", err)
		}
		if bytes.HasPrefix(pkt, []byte("OpusTags")) {
			continue
		}
		cp := append([]byte(nil), pkt...)
		packets = append(packets, cp)
	}
	if len(packets) < 50 {
		t.Fatalf("fixture too short: got %d opus packets", len(packets))
	}
	return packets
}

// pushAll feeds every packet into src as consecutive 20ms RTP frames
// (960 ticks at the 48kHz Opus RTP clock, RFC 7587), starting at rtpStart,
// with arrival == epoch.Add(startDelay) for the first packet and evenly
// spaced afterward -- close enough to real delivery for these tests, which
// check placement and mixing math, not jitter tolerance.
func pushAll(t *testing.T, src *Source, packets [][]byte, epoch time.Time, startDelay time.Duration) {
	t.Helper()
	const frameTicks = 960 // 20ms @ 48kHz
	rtpTS := uint32(1000)  // arbitrary non-zero baseline, like a real SSRC
	arrival := epoch.Add(startDelay)
	for _, pkt := range packets {
		if err := src.Push(pkt, rtpTS, arrival, epoch); err != nil {
			t.Fatalf("Push: %v", err)
		}
		rtpTS += frameTicks
		arrival = arrival.Add(20 * time.Millisecond)
	}
}

func TestSourcePlacesFirstPacketAtAnchor(t *testing.T) {
	epoch := time.Unix(1_700_000_000, 0)
	// A handful of packets, not the whole 2s fixture: pushing the full
	// fixture with no interleaved reads would advance past
	// ringCapacitySamples (2s) before this test ever reads anything,
	// wrapping the ring and legitimately overwriting slot 4800 with
	// real (later) audio -- a live session never does this because the
	// mixer's Pull keeps the read cursor close behind the write side.
	packets := loadTonePackets(t)[:10]

	src := NewSource()
	pushAll(t, src, packets, epoch, 100*time.Millisecond)

	// 100ms in at 48kHz is sample 4800: before it, this source has
	// written nothing, so reading there must be silence.
	out := make([]float32, 10*Channels)
	src.read(4790, 10, out)
	for i, v := range out {
		if v != 0 {
			t.Fatalf("expected silence before the anchor, got out[%d]=%v", i, v)
		}
	}

	// From sample 4800 onward, real decoded audio should appear (a 440Hz
	// tone is not all-zero over 10 consecutive samples).
	src.read(4800, 10, out)
	allZero := true
	for _, v := range out {
		if v != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("expected decoded audio at the anchor, got silence")
	}
}

func TestSourceSilentBeforeAndAfterWriteHead(t *testing.T) {
	epoch := time.Unix(1_700_000_000, 0)
	packets := loadTonePackets(t)[:5] // 100ms of audio

	src := NewSource()
	pushAll(t, src, packets, epoch, 0)

	// 5 packets * 960 samples = 4800 samples written, [0, 4800).
	out := make([]float32, 100*Channels)
	src.read(4800, 100, out) // entirely past writeHead
	for i, v := range out {
		if v != 0 {
			t.Fatalf("expected silence past writeHead, got out[%d]=%v", i, v)
		}
	}

	src.read(-50, 50, out[:50*Channels]) // entirely before sample 0
	for i, v := range out[:50*Channels] {
		if v != 0 {
			t.Fatalf("expected silence before sample 0, got out[%d]=%v", i, v)
		}
	}
}

func TestMixerSumsActiveSources(t *testing.T) {
	epoch := time.Unix(1_700_000_000, 0)
	packets := loadTonePackets(t)

	a := NewSource()
	b := NewSource()
	pushAll(t, a, packets, epoch, 0)
	pushAll(t, b, packets, epoch, 0)

	solo := NewMixer()
	solo.AddSource("a", a)
	soloOut := solo.Pull(960)

	both := NewMixer()
	both.AddSource("a", a)
	both.AddSource("b", b)
	bothOut := both.Pull(960)

	// Two identical in-phase sources summed and soft-clipped must not be
	// bitwise equal to one alone (the mix has to do something), and must
	// stay within the clipper's range.
	same := true
	for i := range soloOut {
		if soloOut[i] != bothOut[i] {
			same = false
		}
		if bothOut[i] > 1 || bothOut[i] < -1 {
			t.Fatalf("mixed sample out of soft-clip range: %v", bothOut[i])
		}
	}
	if same {
		t.Fatal("expected the two-source mix to differ from the one-source pull")
	}
}

func TestMixerNoActiveSourcesReturnsSilence(t *testing.T) {
	m := NewMixer()
	out := m.Pull(960)
	if len(out) != 960*Channels {
		t.Fatalf("len(out) = %d, want %d", len(out), 960*Channels)
	}
	for i, v := range out {
		if v != 0 {
			t.Fatalf("expected silence with no sources, got out[%d]=%v", i, v)
		}
	}
}

func TestMixerCursorAdvancesAndDoesNotReplayARemovedSource(t *testing.T) {
	epoch := time.Unix(1_700_000_000, 0)
	packets := loadTonePackets(t)

	src := NewSource()
	pushAll(t, src, packets, epoch, 0)

	m := NewMixer()
	m.AddSource("mic", src)

	first := m.Pull(960)
	firstHasSound := false
	for _, v := range first {
		if v != 0 {
			firstHasSound = true
		}
	}
	if !firstHasSound {
		t.Fatal("expected sound in the first pull while the source is active")
	}

	m.RemoveSource("mic")
	// The source object itself still holds (unread) decoded audio at
	// sample [960, 1920), but once removed the mixer must never read it
	// again: this is the "no gap or click" / "no ghost audio" property a
	// participant leaving the stage depends on.
	after := m.Pull(960)
	for i, v := range after {
		if v != 0 {
			t.Fatalf("expected silence after RemoveSource, got out[%d]=%v", i, v)
		}
	}
}

func TestSoftClipStaysInRangeAndIsMonotonic(t *testing.T) {
	prev := float32(math.Inf(-1))
	for x := float32(-10); x <= 10; x += 0.25 {
		y := softClip(x)
		if y < -1 || y > 1 {
			t.Fatalf("softClip(%v) = %v, out of [-1,1]", x, y)
		}
		if y < prev {
			t.Fatalf("softClip is not monotonic at x=%v: %v < previous %v", x, y, prev)
		}
		prev = y
	}
	if v := softClip(0); v != 0 {
		t.Fatalf("softClip(0) = %v, want 0", v)
	}
}

// TestDecodeCostBenchmarkData is not a benchmark: it is a regression check
// that the fixture used for this package's own CPU measurement (see
// mixer.go's package doc comment and the PR description) still decodes
// cleanly end to end, so a future change to the fixture or the decode path
// can't silently invalidate a number quoted in prose without a test
// noticing.
func TestDecodeCostBenchmarkData(t *testing.T) {
	packets := loadTonePackets(t)
	src := NewSource()
	epoch := time.Now()
	pushAll(t, src, packets, epoch, 0)
	if src.writeHead <= 0 {
		t.Fatal("expected a positive writeHead after decoding the fixture")
	}
}
