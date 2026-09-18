package skipframe

import (
	"bytes"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// THE CHECK THAT MATTERS. Everything else in this package's tests reads
// the bits this package writes; this one hands them to a real H.264
// decoder and asks two questions no unit test can answer: does the stream
// still decode with zero errors, and is a synthesized frame the SAME
// PICTURE as the one before it, sample for sample?
//
// It runs against ffmpeg with -err_detect explode (any decode error is
// fatal, not concealed) and -f framemd5 (a hash per decoded frame), on a
// stream whose parameter sets match what a screen share really sends:
// Baseline, CAVLC, pic_order_cnt_type 2, max_num_ref_frames 1. Set
// PQP_SKIPFRAME_STREAM to an Annex B .264 file to run it against a
// capture from production instead of the generated one -- which is how
// this was first run, against parts pulled from R2.
//
// It skips when ffmpeg is missing, or cannot encode H.264, rather than
// failing: this module's other tests have no such dependency and a
// machine without ffmpeg must still be able to run them.

func TestRepeatFramesDecodeCleanlyAndRepeatThePreviousPicture(t *testing.T) {
	src := streamUnderTest(t)

	before := frameHashes(t, src)
	if len(before) < 20 {
		t.Fatalf("source stream decoded to %d frames; too few to test against", len(before))
	}

	// Insert three repeats in a row (what a two-second gap needs at a
	// 500ms part target) at several points, including one right after an
	// IDR and one deep into a GOP.
	const insertEvery = 17
	const insertCount = 3
	out, at := insertRepeats(t, src, insertEvery, insertCount)

	after := frameHashes(t, out)

	wantFrames := len(before) + len(at)*insertCount
	if len(after) != wantFrames {
		t.Fatalf("decoded %d frames after inserting %d repeats into %d; want %d",
			len(after), len(at)*insertCount, len(before), wantFrames)
	}

	// Walk both hash lists together: every real frame must decode to
	// exactly the picture it decoded to before, and every inserted frame
	// must decode to the picture immediately before it.
	inserted := map[int]bool{}
	for _, i := range at {
		for k := 0; k < insertCount; k++ {
			inserted[i+k] = true
		}
	}
	b := 0
	for a := 0; a < len(after); a++ {
		if inserted[a] {
			if a == 0 {
				t.Fatal("a repeat frame was inserted before any real frame")
			}
			if after[a] != after[a-1] {
				t.Fatalf("frame %d is a repeat but hashes %s, while the frame before it hashes %s: the picture changed",
					a, after[a], after[a-1])
			}
			continue
		}
		if after[a] != before[b] {
			t.Fatalf("real frame %d (source frame %d) hashes %s after insertion, %s before it: inserting a repeat changed a real picture",
				a, b, after[a], before[b])
		}
		b++
	}
	if b != len(before) {
		t.Fatalf("matched %d of %d real frames", b, len(before))
	}
}

// insertRepeats runs the Annex B stream in src through a Synth, inserting
// n repeat frames before every everyth access unit, and returns the path
// of the rewritten stream plus the DECODED frame indexes the inserted
// frames land on.
func insertRepeats(t *testing.T, src string, every, n int) (string, []int) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("reading %s: %v", src, err)
	}
	nals := splitAnnexB(data)
	aus := groupAccessUnits(nals)

	var sps, pps []byte
	for _, u := range nals {
		switch nal.Type(u[0] & 0x1f) {
		case nal.TypeSPS:
			if sps == nil {
				sps = u
			}
		case nal.TypePPS:
			if pps == nil {
				pps = u
			}
		}
	}
	if sps == nil || pps == nil {
		t.Fatal("stream carries no SPS/PPS")
	}
	s, err := New(sps, pps)
	if err != nil {
		t.Skipf("this stream is not one repeat frames are synthesized for: %v", err)
	}

	var out []byte
	var at []int
	emitted := 0
	rebuilds := 0
	for i, au := range aus {
		// Rebuild on a parameter-set change, which is what
		// session.handleParameterSetChange does in production: the real
		// capture this test was first run against (a Chrome screen
		// share pulled from R2) ramps from 640x360 to 1280x720 at its
		// second IDR, and a skip frame carrying the old picture's
		// macroblock count decodes to a different picture.
		if ns, np := parameterSets(au.nals); ns != nil && np != nil && !bytes.Equal(ns, sps) {
			next, err := New(ns, np)
			if err != nil {
				t.Skipf("the stream's later parameter sets are not synthesizable: %v", err)
			}
			next.Inherit(s)
			s, sps, pps = next, ns, np
			rebuilds++
		}
		if i > 0 && i%every == 0 {
			at = append(at, emitted)
			for k := 0; k < n; k++ {
				rep := s.Repeat()
				if rep == nil {
					t.Fatalf("Repeat unavailable at access unit %d: %s", i, s.Disabled())
				}
				out = appendAnnexB(out, avccUnits(rep))
				emitted++
			}
		}
		out = appendAnnexB(out, avccUnits(s.Observe(avccOf(au.nals), au.isIDR)))
		emitted++
	}
	if int(s.Inserted()) != len(at)*n {
		t.Fatalf("Synth reports %d inserted frames, expected %d", s.Inserted(), len(at)*n)
	}
	if s.Rewritten() == 0 {
		t.Fatal("no real slice was renumbered; the inserted frames would leave a frame_num gap")
	}
	if s.Disabled() != "" {
		t.Fatalf("synthesis disabled itself partway through: %s", s.Disabled())
	}

	path := filepath.Join(t.TempDir(), "with-repeats.264")
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	return path, at
}

// frameHashes decodes one Annex B stream and returns the framemd5 of every
// decoded picture. Any ffmpeg diagnostic at all fails the test:
// -err_detect explode turns a concealed decode error into a hard one, and
// this package's whole claim is that a decoder finds nothing to say about
// what it writes.
func frameHashes(t *testing.T, path string) []string {
	t.Helper()
	cmd := exec.Command(ffmpegPath(t), "-v", "error", "-err_detect", "explode",
		"-i", path, "-f", "framemd5", "-")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("ffmpeg decoding %s: %v\n%s", path, err, stderr.String())
	}
	if msg := strings.TrimSpace(stderr.String()); msg != "" {
		t.Fatalf("ffmpeg reported errors decoding %s:\n%s", path, msg)
	}
	var hashes []string
	for _, line := range strings.Split(stdout.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, ",")
		hashes = append(hashes, strings.TrimSpace(fields[len(fields)-1]))
	}
	return hashes
}

// streamUnderTest returns an Annex B file to run against:
// PQP_SKIPFRAME_STREAM when set (a capture from production), otherwise one
// ffmpeg encodes here with the parameter sets a WebRTC screen share uses.
func streamUnderTest(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("PQP_SKIPFRAME_STREAM"); p != "" {
		return p
	}
	path := filepath.Join(t.TempDir(), "source.264")
	cmd := exec.Command(ffmpegPath(t), "-v", "error",
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1",
		"-x264-params", "keyint=60:bframes=0:ref=1",
		"-t", "4", "-f", "h264", "-y", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Skipf("this ffmpeg cannot encode a baseline H.264 stream to test against: %v\n%s", err, stderr.String())
	}
	return path
}

func ffmpegPath(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not on PATH; the bitstream check needs a real decoder")
	}
	return p
}

type annexBAU struct {
	nals  [][]byte
	isIDR bool
}

func splitAnnexB(b []byte) [][]byte {
	var out [][]byte
	start := -1
	for i := 0; i+3 < len(b); {
		if b[i] == 0 && b[i+1] == 0 && (b[i+2] == 1 || (b[i+2] == 0 && b[i+3] == 1)) {
			sc := 3
			if b[i+2] == 0 {
				sc = 4
			}
			if start >= 0 {
				out = append(out, trimTrailingZeros(b[start:i]))
			}
			start = i + sc
			i += sc
			continue
		}
		i++
	}
	if start >= 0 {
		out = append(out, trimTrailingZeros(b[start:]))
	}
	return out
}

func trimTrailingZeros(b []byte) []byte {
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	return b
}

// groupAccessUnits closes an access unit on every VCL NAL, carrying the
// non-VCL NALs that preceded it. These streams are one slice per picture,
// the same assumption internal/h264's depacketizer makes.
func groupAccessUnits(nals [][]byte) []annexBAU {
	var aus []annexBAU
	var pending [][]byte
	for _, n := range nals {
		if len(n) == 0 {
			continue
		}
		t := nal.Type(n[0] & 0x1f)
		pending = append(pending, n)
		if t == nal.TypeSlice || t == nal.TypeIDR {
			aus = append(aus, annexBAU{nals: pending, isIDR: t == nal.TypeIDR})
			pending = nil
		}
	}
	return aus
}

// parameterSets returns the SPS and PPS an access unit carries in band,
// or nil when it carries none.
func parameterSets(nals [][]byte) (sps, pps []byte) {
	for _, n := range nals {
		switch nal.Type(n[0] & 0x1f) {
		case nal.TypeSPS:
			sps = n
		case nal.TypePPS:
			pps = n
		}
	}
	return sps, pps
}

func avccOf(nals [][]byte) []byte {
	var out []byte
	for _, n := range nals {
		out = nal.AppendAVCC(out, n)
	}
	return out
}

func avccUnits(avcc []byte) [][]byte {
	var out [][]byte
	for len(avcc) >= 4 {
		size := binary.BigEndian.Uint32(avcc[:4])
		avcc = avcc[4:]
		out = append(out, avcc[:size])
		avcc = avcc[size:]
	}
	return out
}

func appendAnnexB(dst []byte, nals [][]byte) []byte {
	for _, n := range nals {
		dst = append(dst, 0, 0, 0, 1)
		dst = append(dst, n...)
	}
	return dst
}
