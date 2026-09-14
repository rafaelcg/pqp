package aacenc

import (
	"bufio"
	"bytes"
	"testing"
)

// buildADTSFrame hand-builds one ADTS frame (protection_absent per the
// arg, no CRC bytes when true) around payload, per ISO/IEC 13818-7 Annex
// B's bit layout -- the same layout readOneADTSFrame decodes, but built
// independently here (field by field, not by copying the parser's own
// arithmetic) so this test can catch a transcription bug in either
// direction. profileIdx/sampleRateIdx/channelConfig are written but never
// asserted on read-back: readOneADTSFrame only needs frame_length and
// protection_absent to find the payload, exactly like an esds-carrying
// CMAF `mp4a` sample entry already carries the rest out of band.
func buildADTSFrame(t *testing.T, protectionAbsent bool, payload []byte) []byte {
	t.Helper()
	const (
		profileIdx    = 1 // AAC LC
		sampleRateIdx = 3 // 48000 Hz
		channelConfig = 2 // stereo
	)
	headerLen := 7
	if !protectionAbsent {
		headerLen = 9
	}
	frameLength := uint32(headerLen + len(payload))

	h := make([]byte, headerLen)
	h[0] = 0xFF
	h[1] = 0xF0 // syncword high nibble + MPEG-4 (ID=0) + layer=00
	if protectionAbsent {
		h[1] |= 0x01
	}
	h[2] = byte(profileIdx<<6) | byte(sampleRateIdx<<2) | byte((channelConfig>>2)&0x01)
	h[3] = byte((channelConfig&0x03)<<6) | byte((frameLength>>11)&0x03)
	h[4] = byte((frameLength >> 3) & 0xFF)
	h[5] = byte((frameLength&0x07)<<5) | 0x1F // buffer_fullness high bits, all set (VBR marker)
	h[6] = 0xFC                               // buffer_fullness low bits all set, raw_data_blocks_in_frame=0 (1 block)
	if !protectionAbsent {
		h[7], h[8] = 0xAB, 0xCD // dummy CRC, never checked by the parser
	}

	return append(h, payload...)
}

func TestReadOneADTSFrameNoCRC(t *testing.T) {
	payload := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	raw := buildADTSFrame(t, true, payload)

	br := bufio.NewReader(bytes.NewReader(raw))
	frame, err := readOneADTSFrame(br)
	if err != nil {
		t.Fatalf("readOneADTSFrame: %v", err)
	}
	if !bytes.Equal(frame.Data, payload) {
		t.Fatalf("got payload %v, want %v", frame.Data, payload)
	}
}

func TestReadOneADTSFrameWithCRC(t *testing.T) {
	payload := bytes.Repeat([]byte{0x42}, 37)
	raw := buildADTSFrame(t, false, payload)

	br := bufio.NewReader(bytes.NewReader(raw))
	frame, err := readOneADTSFrame(br)
	if err != nil {
		t.Fatalf("readOneADTSFrame: %v", err)
	}
	if !bytes.Equal(frame.Data, payload) {
		t.Fatalf("got payload of length %d, want %d", len(frame.Data), len(payload))
	}
}

func TestReadOneADTSFrameSequenceOfFrames(t *testing.T) {
	var buf bytes.Buffer
	var payloads [][]byte
	for i := 0; i < 5; i++ {
		p := bytes.Repeat([]byte{byte(i + 1)}, 20+i*3)
		payloads = append(payloads, p)
		buf.Write(buildADTSFrame(t, true, p))
	}

	br := bufio.NewReader(&buf)
	for i, want := range payloads {
		frame, err := readOneADTSFrame(br)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if !bytes.Equal(frame.Data, want) {
			t.Fatalf("frame %d: got %v, want %v", i, frame.Data, want)
		}
	}
}

func TestReadOneADTSFrameResyncsPastGarbage(t *testing.T) {
	payload := []byte{9, 9, 9}
	var buf bytes.Buffer
	buf.Write([]byte{0x00, 0x01, 0xFF, 0x00, 0xAB}) // noise, including a lone 0xFF that isn't a syncword
	buf.Write(buildADTSFrame(t, true, payload))

	br := bufio.NewReader(&buf)
	frame, err := readOneADTSFrame(br)
	if err != nil {
		t.Fatalf("readOneADTSFrame: %v", err)
	}
	if !bytes.Equal(frame.Data, payload) {
		t.Fatalf("got %v, want %v", frame.Data, payload)
	}
}

func TestReadOneADTSFrameRejectsMultipleBlocks(t *testing.T) {
	raw := buildADTSFrame(t, true, []byte{1, 2, 3})
	raw[6] = (raw[6] &^ 0x03) | 0x01 // 2 raw_data_blocks

	br := bufio.NewReader(bytes.NewReader(raw))
	if _, err := readOneADTSFrame(br); err == nil {
		t.Fatal("expected an error for a multi-block ADTS frame, got nil")
	}
}

func TestReadOneADTSFrameEOF(t *testing.T) {
	br := bufio.NewReader(bytes.NewReader(nil))
	if _, err := readOneADTSFrame(br); err == nil {
		t.Fatal("expected an error reading from an empty stream")
	}
}

// TestADTSAgainstRealFFmpegOutput cross-checks readOneADTSFrame against
// the actual byte layout ffmpeg's own ADTS muxer produced during this
// package's development (captured once with `ffmpeg -c:a aac -f adts`;
// see the PR description for the exact command), so a future ADTS
// layout regression is caught even if it happens to agree with this
// file's own hand-built fixtures.
func TestADTSAgainstRealFFmpegOutput(t *testing.T) {
	// The first 7 bytes an `ffmpeg -c:a aac -b:a 128k -f adts` run
	// produced for a 48kHz stereo stream, verified independently byte by
	// byte in the PR description: protection_absent=1, frame_length=295,
	// raw_data_blocks_in_frame-1=0.
	realHeader := []byte{0xFF, 0xF1, 0x4C, 0x80, 0x24, 0xFF, 0xFC}
	payload := make([]byte, 295-7)
	for i := range payload {
		payload[i] = byte(i)
	}
	raw := append(append([]byte{}, realHeader...), payload...)

	br := bufio.NewReader(bytes.NewReader(raw))
	frame, err := readOneADTSFrame(br)
	if err != nil {
		t.Fatalf("readOneADTSFrame: %v", err)
	}
	if len(frame.Data) != len(payload) {
		t.Fatalf("payload length = %d, want %d", len(frame.Data), len(payload))
	}
}
