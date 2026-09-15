package cmaf

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildAudioInitSegment_TopLevelBoxes(t *testing.T) {
	seg, err := BuildAudioInitSegment(AudioInitParams{Timescale: 48000, SampleRate: 48000, Channels: 2})
	if err != nil {
		t.Fatalf("BuildAudioInitSegment: %v", err)
	}
	boxes, err := parseBoxes(seg)
	if err != nil {
		t.Fatalf("parseBoxes: %v", err)
	}
	if len(boxes) != 2 || boxes[0].Type != "ftyp" || boxes[1].Type != "moov" {
		types := make([]string, len(boxes))
		for i, b := range boxes {
			types[i] = b.Type
		}
		t.Fatalf("expected exactly [ftyp, moov], got %v", types)
	}
}

func TestBuildAudioInitSegment_RejectsBadInputs(t *testing.T) {
	if _, err := BuildAudioInitSegment(AudioInitParams{Timescale: 48000, SampleRate: 48000, Channels: 3}); err == nil {
		t.Fatal("expected an error for Channels=3")
	}
	if _, err := BuildAudioInitSegment(AudioInitParams{Timescale: 48000, SampleRate: 44099, Channels: 2}); err == nil {
		t.Fatal("expected an error for a sample rate with no MPEG-4 index")
	}
}

func TestBuildAudioInitSegment_StsdAndEsds(t *testing.T) {
	seg, err := BuildAudioInitSegment(AudioInitParams{Timescale: 48000, SampleRate: 48000, Channels: 2})
	if err != nil {
		t.Fatalf("BuildAudioInitSegment: %v", err)
	}
	top, _ := parseBoxes(seg)
	moov, _ := findBox(top, "moov")
	moovChildren, _ := parseBoxes(moov.Body)

	trak, ok := findBox(moovChildren, "trak")
	if !ok {
		t.Fatal("moov has no trak")
	}
	trakChildren, _ := parseBoxes(trak.Body)

	mdia, ok := findBox(trakChildren, "mdia")
	if !ok {
		t.Fatal("trak has no mdia")
	}
	mdiaChildren, _ := parseBoxes(mdia.Body)

	hdlr, ok := findBox(mdiaChildren, "hdlr")
	if !ok {
		t.Fatal("mdia has no hdlr")
	}
	_, _, hdlrRest := fullBoxFields(hdlr.Body)
	handlerType := string(hdlrRest[4:8])
	if handlerType != "soun" {
		t.Fatalf("hdlr handler_type = %q, want \"soun\"", handlerType)
	}

	minf, ok := findBox(mdiaChildren, "minf")
	if !ok {
		t.Fatal("mdia has no minf")
	}
	minfChildren, _ := parseBoxes(minf.Body)
	if _, ok := findBox(minfChildren, "smhd"); !ok {
		t.Fatal("minf has no smhd (sound media header)")
	}

	stbl, ok := findBox(minfChildren, "stbl")
	if !ok {
		t.Fatal("minf has no stbl")
	}
	stblChildren, _ := parseBoxes(stbl.Body)
	stsd, ok := findBox(stblChildren, "stsd")
	if !ok {
		t.Fatal("stbl has no stsd")
	}
	_, _, stsdRest := fullBoxFields(stsd.Body)
	entryCount := binary.BigEndian.Uint32(stsdRest[0:4])
	if entryCount != 1 {
		t.Fatalf("stsd entry_count = %d, want 1", entryCount)
	}
	mp4aBoxes, err := parseBoxes(stsdRest[4:])
	if err != nil {
		t.Fatalf("parseBoxes(stsd entries): %v", err)
	}
	mp4a, ok := findBox(mp4aBoxes, "mp4a")
	if !ok {
		t.Fatal("stsd has no mp4a entry")
	}

	// mp4a body: 6 reserved + 2 data_reference_index + 8 reserved +
	// channelcount(2) + samplesize(2) + pre_defined(2) + reserved(2) +
	// samplerate(4) = 28 bytes, then esds.
	channels := binary.BigEndian.Uint16(mp4a.Body[16:18])
	sampleSize := binary.BigEndian.Uint16(mp4a.Body[18:20])
	sampleRate := binary.BigEndian.Uint32(mp4a.Body[24:28]) >> 16
	if channels != 2 {
		t.Fatalf("mp4a channelcount = %d, want 2", channels)
	}
	if sampleSize != 16 {
		t.Fatalf("mp4a samplesize = %d, want 16", sampleSize)
	}
	if sampleRate != 48000 {
		t.Fatalf("mp4a samplerate = %d, want 48000", sampleRate)
	}

	esdsBoxes, err := parseBoxes(mp4a.Body[28:])
	if err != nil {
		t.Fatalf("parseBoxes(mp4a tail): %v", err)
	}
	esds, ok := findBox(esdsBoxes, "esds")
	if !ok {
		t.Fatal("mp4a has no esds")
	}
	_, _, esdsRest := fullBoxFields(esds.Body)
	if esdsRest[0] != 0x03 {
		t.Fatalf("esds does not start with an ES_Descriptor tag (0x03): got 0x%02X", esdsRest[0])
	}
	// The AudioSpecificConfig for AAC-LC (object type 2) @ 48000 (index 3)
	// stereo (channel config 2) is fixed: 0b00010_0011 0b0_0010_000 = 0x11
	// 0x90.
	if !containsBytes(esdsRest, []byte{0x11, 0x90}) {
		t.Fatalf("esds does not contain the expected AudioSpecificConfig bytes [0x11 0x90]: % X", esdsRest)
	}
}

func containsBytes(haystack, needle []byte) bool {
	if len(needle) == 0 || len(haystack) < len(needle) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// TestAudioSpecificConfigMatchesKnownEncodings checks audioSpecificConfig
// directly against values independently computed from ISO/IEC 14496-3
// Table 1.6.3 (object type 2 = AAC LC; sampling frequency index 3 = 48000,
// 4 = 44100; channelConfiguration as given): AudioObjectType(5) |
// samplingFrequencyIndex(4) | channelConfiguration(4) | 000 padding, 16
// bits total.
func TestAudioSpecificConfigMatchesKnownEncodings(t *testing.T) {
	cases := []struct {
		name       string
		sampleRate uint32
		channels   uint16
		wantHex    [2]byte
	}{
		{"48000 stereo", 48000, 2, [2]byte{0x11, 0x90}},
		{"44100 mono", 44100, 1, [2]byte{0x12, 0x08}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			asc, err := audioSpecificConfig(c.sampleRate, c.channels)
			if err != nil {
				t.Fatalf("audioSpecificConfig: %v", err)
			}
			if len(asc) != 2 || asc[0] != c.wantHex[0] || asc[1] != c.wantHex[1] {
				t.Fatalf("audioSpecificConfig(%d, %d) = % X, want % X", c.sampleRate, c.channels, asc, c.wantHex[:])
			}
		})
	}
}

// TestAudioInitSegmentParsesWithFFprobe cross-checks the whole box tree
// against a real, independent MP4 parser: this catches a structural
// mistake (a bad size, a box in the wrong place, a malformed esds) that
// this file's own hand-rolled parseBoxes helper could share a blind spot
// with, since it was written by the same person against the same spec
// reading. Skips when ffprobe is not on PATH, matching
// internal/aacenc's own requireFFmpeg pattern.
func TestAudioInitSegmentParsesWithFFprobe(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not found on PATH; skipping the real-parser cross-check")
	}

	seg, err := BuildAudioInitSegment(AudioInitParams{Timescale: 48000, SampleRate: 48000, Channels: 2})
	if err != nil {
		t.Fatalf("BuildAudioInitSegment: %v", err)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "audio-init.mp4")
	if err := os.WriteFile(path, seg, 0o644); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}

	out, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-of", "default=noprint_wrappers=1", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ffprobe rejected the init segment: %v\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "codec_name=aac") {
		t.Fatalf("ffprobe did not report an aac stream:\n%s", got)
	}
	if !strings.Contains(got, "codec_type=audio") {
		t.Fatalf("ffprobe did not report an audio stream:\n%s", got)
	}
}
