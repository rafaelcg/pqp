package nal

import "testing"

// bitWriter is the test-only mirror of bitReader: it lets these tests build
// a real SPS bitstream from chosen field values instead of hand-copying
// bytes from an unrelated encoder, so a round trip through ParseSPS proves
// the Exp-Golomb and bit-consumption logic, not a fixture we don't control.
type bitWriter struct {
	bytes []byte
	cur   byte
	nbits uint
}

func (w *bitWriter) writeBit(b uint32) {
	w.cur = (w.cur << 1) | byte(b&1)
	w.nbits++
	if w.nbits == 8 {
		w.bytes = append(w.bytes, w.cur)
		w.cur = 0
		w.nbits = 0
	}
}

func (w *bitWriter) writeBits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.writeBit((v >> uint(i)) & 1)
	}
}

func (w *bitWriter) writeUE(v uint32) {
	// Exp-Golomb: leading zeros = bit-length(v+1) - 1, then v+1 itself.
	x := v + 1
	nbits := 0
	for t := x; t > 1; t >>= 1 {
		nbits++
	}
	for i := 0; i < nbits; i++ {
		w.writeBit(0)
	}
	w.writeBits(x, nbits+1)
}

func (w *bitWriter) writeSE(v int32) {
	var k uint32
	if v <= 0 {
		k = uint32(-2 * v)
	} else {
		k = uint32(2*v - 1)
	}
	w.writeUE(k)
}

// finish pads the last byte with zero bits (as if rbsp_trailing_bits had
// already been consumed by the reader before running out of data) and
// returns the RBSP bytes with no emulation prevention needed, since none of
// these synthetic streams happen to produce two 0x00 bytes followed by a
// byte <= 3.
func (w *bitWriter) finish() []byte {
	for w.nbits != 0 {
		w.writeBit(0)
	}
	return w.bytes
}

// buildSPS writes a syntactically valid SPS RBSP (NAL header included) for
// the given profile, width and height, optionally exercising the
// chroma/scaling-matrix branch that only High-tier profiles carry.
func buildSPS(t *testing.T, profileIdc uint8, width, height uint32, withScalingMatrix bool) []byte {
	t.Helper()

	// Choose crop-free dimensions: width/height must already be multiples
	// of 16 (and 16*(2-frame_mbs_only) for height) so frame_cropping can
	// stay off and the formula in ParseSPS reduces to the macroblock count.
	if width%16 != 0 || height%16 != 0 {
		t.Fatalf("buildSPS: width/height must be multiples of 16, got %dx%d", width, height)
	}

	w := &bitWriter{}
	w.writeBits(uint32(profileIdc), 8) // profile_idc
	w.writeBits(0, 8)                  // constraint flags + reserved
	w.writeBits(31, 8)                 // level_idc (arbitrary, e.g. 3.1)
	w.writeUE(0)                       // seq_parameter_set_id

	if hasChromaInfo(profileIdc) {
		w.writeUE(1)  // chroma_format_idc = 4:2:0
		w.writeUE(0)  // bit_depth_luma_minus8
		w.writeUE(0)  // bit_depth_chroma_minus8
		w.writeBit(0) // qpprime_y_zero_transform_bypass_flag
		if withScalingMatrix {
			w.writeBit(1) // seq_scaling_matrix_present_flag
			for i := 0; i < 8; i++ {
				w.writeBit(1) // seq_scaling_list_present_flag[i]
				size := 16
				if i >= 6 {
					size = 64
				}
				for j := 0; j < size; j++ {
					w.writeSE(0) // delta_scale = 0 => identity list
				}
			}
		} else {
			w.writeBit(0) // seq_scaling_matrix_present_flag
		}
	}

	w.writeUE(4) // log2_max_frame_num_minus4
	w.writeUE(0) // pic_order_cnt_type = 0
	w.writeUE(4) // log2_max_pic_order_cnt_lsb_minus4

	w.writeUE(1)  // max_num_ref_frames
	w.writeBit(0) // gaps_in_frame_num_value_allowed_flag

	picWidthInMbsMinus1 := width/16 - 1
	picHeightInMapUnitsMinus1 := height/16 - 1
	w.writeUE(picWidthInMbsMinus1)
	w.writeUE(picHeightInMapUnitsMinus1)
	w.writeBit(1) // frame_mbs_only_flag
	w.writeBit(1) // direct_8x8_inference_flag
	w.writeBit(0) // frame_cropping_flag (off: dimensions already exact)

	// rbsp_trailing_bits: stop bit, then zero-pad. ParseSPS never reads
	// this far, so its exact shape does not matter to the test, only that
	// there is enough buffer for the reader to not overrun on the fields
	// above.
	w.writeBit(1)

	rbsp := w.finish()
	nalHeader := byte(TypeSPS) // forbidden_zero_bit=0, nal_ref_idc=0
	return append([]byte{nalHeader}, rbsp...)
}

func TestParseSPS_Baseline(t *testing.T) {
	sps := buildSPS(t, 66, 1280, 720, false)
	info, err := ParseSPS(sps)
	if err != nil {
		t.Fatalf("ParseSPS: %v", err)
	}
	if info.Width != 1280 || info.Height != 720 {
		t.Fatalf("got %dx%d, want 1280x720", info.Width, info.Height)
	}
}

func TestParseSPS_HighProfileWithScalingMatrix(t *testing.T) {
	sps := buildSPS(t, 100, 1920, 1088, true)
	info, err := ParseSPS(sps)
	if err != nil {
		t.Fatalf("ParseSPS: %v", err)
	}
	if info.Width != 1920 || info.Height != 1088 {
		t.Fatalf("got %dx%d, want 1920x1088", info.Width, info.Height)
	}
}

func TestParseSPS_SmallDesktopCapture(t *testing.T) {
	sps := buildSPS(t, 66, 640, 368, false)
	info, err := ParseSPS(sps)
	if err != nil {
		t.Fatalf("ParseSPS: %v", err)
	}
	if info.Width != 640 || info.Height != 368 {
		t.Fatalf("got %dx%d, want 640x368", info.Width, info.Height)
	}
}

// TestUnescapeRBSP directly exercises the emulation-prevention stripper
// Farol flagged as possibly leaving a second inserted 0x03 behind on
// consecutive escapes. It does not: per ITU-T H.264 §7.3.1/7.4.1.1, an
// encoder's own zero-counter resets to 0 the instant it inserts an escape
// byte (it does not carry the two zero bytes it just "spent" forward into
// a new potential match), and this decoder mirrors that exactly. Each case
// here was verified by hand-simulating the standard encoder algorithm
// (count consecutive raw zero bytes; on the 2nd zero followed by a byte
// <=3, insert 0x03 and reset the counter to 0) to confirm the "encoded"
// column really is what an encoder would produce for the "original"
// column, so this test is checking against the spec's algorithm, not
// against this package's own inverse of itself.
func TestUnescapeRBSP(t *testing.T) {
	cases := []struct {
		name     string
		encoded  []byte
		original []byte
	}{
		{
			name:     "no escape needed",
			encoded:  []byte{0x01, 0x02, 0x03, 0x04},
			original: []byte{0x01, 0x02, 0x03, 0x04},
		},
		{
			name:     "single escape",
			encoded:  []byte{0x00, 0x00, 0x03, 0x01},
			original: []byte{0x00, 0x00, 0x01},
		},
		{
			name:     "two independent escapes back to back",
			encoded:  []byte{0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x03},
			original: []byte{0x00, 0x00, 0x00, 0x00, 0x03},
		},
		{
			// Farol's own example: the byte immediately after a stripped
			// escape is itself 0x03, but it is genuine data (only ONE
			// zero — not two — precedes it), so it must survive.
			name:     "genuine 0x03 immediately after a stripped escape",
			encoded:  []byte{0x00, 0x00, 0x03, 0x00, 0x03, 0x00},
			original: []byte{0x00, 0x00, 0x00, 0x03, 0x00},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := unescapeRBSP(c.encoded)
			if !bytesEqual(got, c.original) {
				t.Fatalf("unescapeRBSP(% X) = % X, want % X", c.encoded, got, c.original)
			}
		})
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestParseSPS_RejectsNonSPS(t *testing.T) {
	if _, err := ParseSPS([]byte{byte(TypeIDR), 0, 0, 0}); err == nil {
		t.Fatal("expected an error for a non-SPS NAL type")
	}
}

func TestParseSPS_RejectsShortInput(t *testing.T) {
	if _, err := ParseSPS([]byte{byte(TypeSPS)}); err == nil {
		t.Fatal("expected an error for a truncated SPS")
	}
}
