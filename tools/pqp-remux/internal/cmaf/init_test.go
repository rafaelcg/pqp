package cmaf

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// testBitWriter is a small, local mirror of the nal package's own
// (unexported) test bit writer: cmaf can't import an internal test helper
// from another package, and hand-typing SPS bytes here would mean trusting
// magic numbers no test actually derives. Building the bitstream from named
// field values and letting BuildInitSegment's own call into nal.ParseSPS
// decode it is what makes these fixtures trustworthy.
type testBitWriter struct {
	bytes []byte
	cur   byte
	nbits uint
}

func (w *testBitWriter) writeBit(b uint32) {
	w.cur = (w.cur << 1) | byte(b&1)
	w.nbits++
	if w.nbits == 8 {
		w.bytes = append(w.bytes, w.cur)
		w.cur = 0
		w.nbits = 0
	}
}

func (w *testBitWriter) writeBits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.writeBit((v >> uint(i)) & 1)
	}
}

func (w *testBitWriter) writeUE(v uint32) {
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

func (w *testBitWriter) writeSE(v int32) {
	var k uint32
	if v <= 0 {
		k = uint32(-2 * v)
	} else {
		k = uint32(2*v - 1)
	}
	w.writeUE(k)
}

func (w *testBitWriter) finish() []byte {
	for w.nbits != 0 {
		w.writeBit(0)
	}
	return w.bytes
}

// buildTestSPS writes a syntactically valid baseline-profile SPS (no
// chroma/scaling-matrix branch) for the given crop-free width/height
// (both must be multiples of 16).
func buildTestSPS(t *testing.T, width, height uint32) []byte {
	t.Helper()
	if width%16 != 0 || height%16 != 0 {
		t.Fatalf("buildTestSPS: %dx%d must be multiples of 16", width, height)
	}
	w := &testBitWriter{}
	w.writeBits(66, 8) // profile_idc: baseline
	w.writeBits(0, 8)  // constraint flags + reserved
	w.writeBits(31, 8) // level_idc
	w.writeUE(0)       // seq_parameter_set_id
	w.writeUE(4)       // log2_max_frame_num_minus4
	w.writeUE(0)       // pic_order_cnt_type
	w.writeUE(4)       // log2_max_pic_order_cnt_lsb_minus4
	w.writeUE(1)       // max_num_ref_frames
	w.writeBit(0)      // gaps_in_frame_num_value_allowed_flag
	w.writeUE(width/16 - 1)
	w.writeUE(height/16 - 1)
	w.writeBit(1) // frame_mbs_only_flag
	w.writeBit(1) // direct_8x8_inference_flag
	w.writeBit(0) // frame_cropping_flag
	w.writeBit(1) // rbsp stop bit
	rbsp := w.finish()
	return append([]byte{0x07}, rbsp...) // NAL header: type 7 (SPS)
}

// buildTestHighProfileSPS writes a High-profile (100) SPS carrying the
// given chroma_format_idc/bit-depth fields and an all-identity scaling
// matrix, the branch only High-tier profiles take (nal.hasChromaInfo).
func buildTestHighProfileSPS(t *testing.T, width, height, chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8 uint32) []byte {
	t.Helper()
	if width%16 != 0 || height%16 != 0 {
		t.Fatalf("buildTestHighProfileSPS: %dx%d must be multiples of 16", width, height)
	}
	w := &testBitWriter{}
	w.writeBits(100, 8) // profile_idc: High
	w.writeBits(0, 8)
	w.writeBits(40, 8) // level_idc
	w.writeUE(0)       // seq_parameter_set_id
	w.writeUE(chromaFormatIdc)
	w.writeUE(bitDepthLumaMinus8)
	w.writeUE(bitDepthChromaMinus8)
	w.writeBit(0) // qpprime_y_zero_transform_bypass_flag
	w.writeBit(1) // seq_scaling_matrix_present_flag
	for i := 0; i < 8; i++ {
		w.writeBit(1) // seq_scaling_list_present_flag[i]
		size := 16
		if i >= 6 {
			size = 64
		}
		for j := 0; j < size; j++ {
			w.writeSE(0) // delta_scale = 0: identity list
		}
	}
	w.writeUE(4) // log2_max_frame_num_minus4
	w.writeUE(0) // pic_order_cnt_type
	w.writeUE(4) // log2_max_pic_order_cnt_lsb_minus4
	w.writeUE(1) // max_num_ref_frames
	w.writeBit(0)
	w.writeUE(width/16 - 1)
	w.writeUE(height/16 - 1)
	w.writeBit(1) // frame_mbs_only_flag
	w.writeBit(1) // direct_8x8_inference_flag
	w.writeBit(0) // frame_cropping_flag
	w.writeBit(1) // stop bit
	rbsp := w.finish()
	return append([]byte{0x07}, rbsp...)
}

func TestBuildInitSegment_TopLevelBoxes(t *testing.T) {
	// This SPS is hand-rolled bits, easy to get subtly wrong; if it fails to
	// parse the test itself is broken, not the muxer, so fail loudly rather
	// than silently exercising the error path.
	sps := buildTestSPS(t, 1280, 720)
	pps := []byte{0x08, 0xAA, 0xBB}

	seg, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: sps, PPS: pps})
	if err != nil {
		t.Fatalf("BuildInitSegment: %v (fix buildTestSPS if this is a parse error)", err)
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

func TestBuildInitSegment_MoovStructureAndAvcC(t *testing.T) {
	sps := buildTestSPS(t, 1280, 720)
	pps := []byte{0x08, 0xAA, 0xBB}

	seg, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: sps, PPS: pps})
	if err != nil {
		t.Fatalf("BuildInitSegment: %v", err)
	}
	top, err := parseBoxes(seg)
	if err != nil {
		t.Fatalf("parseBoxes: %v", err)
	}
	moov, ok := findBox(top, "moov")
	if !ok {
		t.Fatal("no moov box")
	}
	moovChildren, err := parseBoxes(moov.Body)
	if err != nil {
		t.Fatalf("parseBoxes(moov): %v", err)
	}

	mvhd, ok := findBox(moovChildren, "mvhd")
	if !ok {
		t.Fatal("moov has no mvhd")
	}
	_, _, mvhdRest := fullBoxFields(mvhd.Body)
	gotTimescale := binary.BigEndian.Uint32(mvhdRest[8:12]) // after creation_time, modification_time
	if gotTimescale != 90000 {
		t.Fatalf("mvhd timescale = %d, want 90000", gotTimescale)
	}

	trak, ok := findBox(moovChildren, "trak")
	if !ok {
		t.Fatal("moov has no trak")
	}
	trakChildren, err := parseBoxes(trak.Body)
	if err != nil {
		t.Fatalf("parseBoxes(trak): %v", err)
	}
	tkhd, ok := findBox(trakChildren, "tkhd")
	if !ok {
		t.Fatal("trak has no tkhd")
	}
	_, tkhdFlags, tkhdRest := fullBoxFields(tkhd.Body)
	if tkhdFlags != 0x000007 {
		t.Fatalf("tkhd flags = 0x%06X, want 0x000007 (enabled|in-movie|in-preview)", tkhdFlags)
	}
	trackID := binary.BigEndian.Uint32(tkhdRest[8:12]) // after creation_time, modification_time
	if trackID != TrackID {
		t.Fatalf("tkhd track_ID = %d, want %d", trackID, TrackID)
	}
	// width/height are the last two u32 fields (16.16 fixed point).
	width := binary.BigEndian.Uint32(tkhdRest[len(tkhdRest)-8:len(tkhdRest)-4]) >> 16
	height := binary.BigEndian.Uint32(tkhdRest[len(tkhdRest)-4:]) >> 16
	if width != 1280 || height != 720 {
		t.Fatalf("tkhd dimensions = %dx%d, want 1280x720", width, height)
	}

	mdia, ok := findBox(trakChildren, "mdia")
	if !ok {
		t.Fatal("trak has no mdia")
	}
	mdiaChildren, err := parseBoxes(mdia.Body)
	if err != nil {
		t.Fatalf("parseBoxes(mdia): %v", err)
	}
	minf, ok := findBox(mdiaChildren, "minf")
	if !ok {
		t.Fatal("mdia has no minf")
	}
	minfChildren, err := parseBoxes(minf.Body)
	if err != nil {
		t.Fatalf("parseBoxes(minf): %v", err)
	}
	stbl, ok := findBox(minfChildren, "stbl")
	if !ok {
		t.Fatal("minf has no stbl")
	}
	stblChildren, err := parseBoxes(stbl.Body)
	if err != nil {
		t.Fatalf("parseBoxes(stbl): %v", err)
	}
	stsd, ok := findBox(stblChildren, "stsd")
	if !ok {
		t.Fatal("stbl has no stsd")
	}
	_, _, stsdRest := fullBoxFields(stsd.Body)
	entryCount := binary.BigEndian.Uint32(stsdRest[0:4])
	if entryCount != 1 {
		t.Fatalf("stsd entry_count = %d, want 1", entryCount)
	}
	sampleEntries, err := parseBoxes(stsdRest[4:])
	if err != nil {
		t.Fatalf("parseBoxes(stsd entries): %v", err)
	}
	avc1, ok := findBox(sampleEntries, "avc1")
	if !ok {
		t.Fatal("stsd has no avc1 sample entry")
	}

	// avc1's fixed VisualSampleEntry header is 78 bytes before its own
	// nested boxes (reserved 6 + data_ref_index 2 + pre_defined/reserved 16
	// + width/height 4 + h/v-res 8 + reserved 4 + frame_count 2 +
	// compressorname 32 + depth 2 + pre_defined 2 = 78).
	const avc1FixedHeaderLen = 78
	if len(avc1.Body) <= avc1FixedHeaderLen {
		t.Fatalf("avc1 body too short: %d bytes", len(avc1.Body))
	}
	avc1Width := binary.BigEndian.Uint16(avc1.Body[24:26])
	avc1Height := binary.BigEndian.Uint16(avc1.Body[26:28])
	if avc1Width != 1280 || avc1Height != 720 {
		t.Fatalf("avc1 dimensions = %dx%d, want 1280x720", avc1Width, avc1Height)
	}

	avc1Children, err := parseBoxes(avc1.Body[avc1FixedHeaderLen:])
	if err != nil {
		t.Fatalf("parseBoxes(avc1 nested): %v", err)
	}
	avcC, ok := findBox(avc1Children, "avcC")
	if !ok {
		t.Fatal("avc1 has no avcC")
	}
	if avcC.Body[0] != 1 {
		t.Fatalf("avcC configurationVersion = %d, want 1", avcC.Body[0])
	}
	if avcC.Body[1] != sps[1] || avcC.Body[2] != sps[2] || avcC.Body[3] != sps[3] {
		t.Fatalf("avcC profile/compat/level = %v, want %v", avcC.Body[1:4], sps[1:4])
	}
	numSPS := avcC.Body[5] & 0x1F
	if numSPS != 1 {
		t.Fatalf("avcC numOfSequenceParameterSets = %d, want 1", numSPS)
	}
	spsLen := binary.BigEndian.Uint16(avcC.Body[6:8])
	gotSPS := avcC.Body[8 : 8+int(spsLen)]
	if !bytes.Equal(gotSPS, sps) {
		t.Fatalf("avcC SPS bytes were not preserved byte for byte")
	}
	after := avcC.Body[8+int(spsLen):]
	numPPS := after[0]
	if numPPS != 1 {
		t.Fatalf("avcC numOfPictureParameterSets = %d, want 1", numPPS)
	}
	ppsLen := binary.BigEndian.Uint16(after[1:3])
	gotPPS := after[3 : 3+int(ppsLen)]
	if !bytes.Equal(gotPPS, pps) {
		t.Fatalf("avcC PPS bytes were not preserved byte for byte")
	}

	mvex, ok := findBox(moovChildren, "mvex")
	if !ok {
		t.Fatal("moov has no mvex (required for a fragmented movie)")
	}
	mvexChildren, err := parseBoxes(mvex.Body)
	if err != nil {
		t.Fatalf("parseBoxes(mvex): %v", err)
	}
	if _, ok := findBox(mvexChildren, "trex"); !ok {
		t.Fatal("mvex has no trex")
	}
}

func TestBuildInitSegment_RejectsMissingSPSOrPPS(t *testing.T) {
	if _, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: nil, PPS: []byte{1}}); err == nil {
		t.Fatal("expected an error with no SPS")
	}
	if _, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: buildTestSPS(t, 1280, 720), PPS: nil}); err == nil {
		t.Fatal("expected an error with no PPS")
	}
}

// avcCFromInitSegment walks a built init segment down to its avcC box body,
// for tests that need to inspect the AVCDecoderConfigurationRecord bytes
// directly.
func avcCFromInitSegment(t *testing.T, seg []byte) parsedBox {
	t.Helper()
	top, err := parseBoxes(seg)
	if err != nil {
		t.Fatalf("parseBoxes: %v", err)
	}
	moov, _ := findBox(top, "moov")
	moovChildren, _ := parseBoxes(moov.Body)
	trak, _ := findBox(moovChildren, "trak")
	trakChildren, _ := parseBoxes(trak.Body)
	mdia, _ := findBox(trakChildren, "mdia")
	mdiaChildren, _ := parseBoxes(mdia.Body)
	minf, _ := findBox(mdiaChildren, "minf")
	minfChildren, _ := parseBoxes(minf.Body)
	stbl, _ := findBox(minfChildren, "stbl")
	stblChildren, _ := parseBoxes(stbl.Body)
	stsd, _ := findBox(stblChildren, "stsd")
	_, _, stsdRest := fullBoxFields(stsd.Body)
	sampleEntries, _ := parseBoxes(stsdRest[4:])
	avc1, _ := findBox(sampleEntries, "avc1")
	avc1Children, _ := parseBoxes(avc1.Body[78:])
	avcC, ok := findBox(avc1Children, "avcC")
	if !ok {
		t.Fatal("no avcC box found in the built init segment")
	}
	return avcC
}

func TestBuildInitSegment_HighProfileGetsAvcCExtension(t *testing.T) {
	sps := buildTestHighProfileSPS(t, 1920, 1088, 1, 0, 0) // 4:2:0, 8-bit
	pps := []byte{0x08, 0x01}

	seg, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: sps, PPS: pps})
	if err != nil {
		t.Fatalf("BuildInitSegment: %v", err)
	}
	avcC := avcCFromInitSegment(t, seg)

	// body: 1(ver)+3(profile/compat/level)+1(lengthSize)+1(numSPS)+2+len(sps)+1(numPPS)+2+len(pps) then the 4-byte extension.
	wantLenWithoutExt := 1 + 3 + 1 + 1 + 2 + len(sps) + 1 + 2 + len(pps)
	if len(avcC.Body) != wantLenWithoutExt+4 {
		t.Fatalf("High profile avcC body length = %d, want %d (extension present)", len(avcC.Body), wantLenWithoutExt+4)
	}
}

// TestBuildInitSegment_AvcCReflectsActualChromaAndBitDepth is the
// regression test for the bug Farol caught: buildAvcC used to hardcode
// chroma_format=4:2:0 and bit_depth=8 into the extension regardless of
// what the SPS actually said, so a genuinely 4:2:2 or 10-bit stream's
// init segment would describe different decoder parameters than its own
// SPS. This builds a High-profile SPS with 4:2:2 chroma and 10-bit luma
// (bit_depth_luma_minus8 = 2) and asserts avcC's extension bytes carry
// those exact values, not the 4:2:0/8-bit defaults.
func TestBuildInitSegment_AvcCReflectsActualChromaAndBitDepth(t *testing.T) {
	const chromaFormatIdc = 2 // 4:2:2
	const bitDepthLumaMinus8 = 2
	const bitDepthChromaMinus8 = 2
	sps := buildTestHighProfileSPS(t, 1920, 1088, chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8)
	pps := []byte{0x08, 0x01}

	seg, err := BuildInitSegment(InitParams{Timescale: 90000, SPS: sps, PPS: pps})
	if err != nil {
		t.Fatalf("BuildInitSegment: %v", err)
	}
	avcC := avcCFromInitSegment(t, seg)

	// Extension is the last 4 bytes: chroma_format, bit_depth_luma_minus8,
	// bit_depth_chroma_minus8, numOfSequenceParameterSetExt.
	ext := avcC.Body[len(avcC.Body)-4:]
	if got := ext[0] & 0x03; got != chromaFormatIdc {
		t.Fatalf("avcC chroma_format = %d, want %d (must match the SPS, not the 4:2:0 default)", got, chromaFormatIdc)
	}
	if got := ext[1] & 0x07; got != bitDepthLumaMinus8 {
		t.Fatalf("avcC bit_depth_luma_minus8 = %d, want %d", got, bitDepthLumaMinus8)
	}
	if got := ext[2] & 0x07; got != bitDepthChromaMinus8 {
		t.Fatalf("avcC bit_depth_chroma_minus8 = %d, want %d", got, bitDepthChromaMinus8)
	}
}

func TestNeedsAvcCHighProfileExt(t *testing.T) {
	for _, p := range []uint8{100, 110, 122, 144} {
		if !needsAvcCHighProfileExt(p) {
			t.Errorf("profile %d should need the avcC extension", p)
		}
	}
	for _, p := range []uint8{66, 77, 88, 42} {
		if needsAvcCHighProfileExt(p) {
			t.Errorf("profile %d should not need the avcC extension", p)
		}
	}
}
