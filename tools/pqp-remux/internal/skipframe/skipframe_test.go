package skipframe

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// The parameter sets below are the ones a real pqp watch party published:
// read out of the init segment of a Chrome screen share pulled from R2 on
// 2026-09-17. Baseline profile 66, CAVLC, pic_order_cnt_type 2,
// max_num_ref_frames 1, log2_max_frame_num 15, 640x360 (40x23
// macroblocks). Using the real ones rather than a hand-built pair is
// deliberate: every refusal in New is a statement about what Chrome
// sends, and a fixture we invented could not contradict us.
const (
	prodSPSHex = "6742c01e8c680a02ff966a0202020f08846a"
	prodPPSHex = "68ce3c80"
	prodMbs    = 40 * 23
)

func prodSets(t *testing.T) (sps, pps []byte) {
	t.Helper()
	s, err := hex.DecodeString(prodSPSHex)
	if err != nil {
		t.Fatal(err)
	}
	p, err := hex.DecodeString(prodPPSHex)
	if err != nil {
		t.Fatal(err)
	}
	return s, p
}

func prodSynth(t *testing.T) *Synth {
	t.Helper()
	sps, pps := prodSets(t)
	s, err := New(sps, pps)
	if err != nil {
		t.Fatalf("New on the production parameter sets: %v", err)
	}
	return s
}

// idrAU is an access unit shaped like the ones Chrome sends: parameter
// sets, then the IDR slice itself.
func idrAU(t *testing.T, frameNum uint32) []byte {
	t.Helper()
	sps, pps := prodSets(t)
	out := nal.AppendAVCC(nil, sps)
	out = nal.AppendAVCC(out, pps)
	return nal.AppendAVCC(out, sliceNAL(t, nal.TypeIDR, 3, frameNum))
}

// sliceNAL builds a slice NAL with a chosen frame_num. Only the header
// fields this package reads are meaningful; what follows them is filler,
// which is all a frame_num rewrite is allowed to care about.
func sliceNAL(t *testing.T, typ nal.Type, refIdcValue uint8, frameNum uint32) []byte {
	t.Helper()
	var w bitWriter
	w.ue(0) // first_mb_in_slice
	if typ == nal.TypeIDR {
		w.ue(7) // slice_type: I, all slices
	} else {
		w.ue(5) // slice_type: P, all slices
	}
	w.ue(0)              // pic_parameter_set_id
	w.bits(frameNum, 15) // frame_num, 15 bits per the production SPS
	if typ == nal.TypeIDR {
		w.ue(0)  // idr_pic_id
		w.bit(0) // no_output_of_prior_pics_flag
		w.bit(0) // long_term_reference_flag
	} else {
		w.bit(0) // num_ref_idx_active_override_flag
		w.bit(0) // ref_pic_list_modification_flag_l0
		w.bit(0) // adaptive_ref_pic_marking_mode_flag
	}
	w.se(0)  // slice_qp_delta
	w.ue(1)  // disable_deblocking_filter_idc
	w.ue(17) // mb_skip_run: filler, never read back
	rbsp := w.trailing()
	out := []byte{byte(refIdcValue<<5) | byte(typ)}
	return append(out, nal.EscapeRBSP(rbsp)...)
}

// readFrameNum pulls frame_num back out of a slice NAL, the way a decoder
// would.
func readFrameNum(t *testing.T, payload []byte) uint32 {
	t.Helper()
	r := newBitReader(nal.UnescapeRBSP(payload[1:]))
	r.ue()
	r.ue()
	r.ue()
	v := r.bits(15)
	if r.err != nil {
		t.Fatalf("reading frame_num: %v", r.err)
	}
	return v
}

func onlySlice(t *testing.T, avcc []byte) nal.Unit {
	t.Helper()
	units, err := nal.ParseAVCC(avcc)
	if err != nil {
		t.Fatalf("parsing AVCC: %v", err)
	}
	for _, u := range units {
		if u.IsSlice() {
			return u
		}
	}
	t.Fatal("no slice in the access unit")
	return nal.Unit{}
}

func TestRepeatSliceCarriesTheFieldsADecoderReads(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)

	frame := s.Repeat()
	if frame == nil {
		t.Fatalf("Repeat returned nothing right after an IDR: %s", s.Disabled())
	}
	u := onlySlice(t, frame)
	if u.Type != nal.TypeSlice {
		t.Fatalf("nal_unit_type %d, want %d (non-IDR slice)", u.Type, nal.TypeSlice)
	}
	if u.RefIdc == 0 {
		t.Fatal("nal_ref_idc is 0: a non-reference repeat would derive the same picture order count as the next one, which pic_order_cnt_type 2 forbids")
	}

	r := newBitReader(nal.UnescapeRBSP(u.Payload[1:]))
	if got := r.ue(); got != 0 {
		t.Fatalf("first_mb_in_slice = %d, want 0", got)
	}
	if got := r.ue(); got != pSliceAllP {
		t.Fatalf("slice_type = %d, want %d (P, all slices)", got, pSliceAllP)
	}
	if got := r.ue(); got != 0 {
		t.Fatalf("pic_parameter_set_id = %d, want 0", got)
	}
	if got := r.bits(15); got != 1 {
		t.Fatalf("frame_num = %d, want 1 (the IDR was 0)", got)
	}
	if got := r.bit(); got != 0 {
		t.Fatalf("num_ref_idx_active_override_flag = %d, want 0", got)
	}
	if got := r.bit(); got != 0 {
		t.Fatalf("ref_pic_list_modification_flag_l0 = %d, want 0: reference index 0 must stay the newest picture", got)
	}
	if got := r.bit(); got != 0 {
		t.Fatalf("adaptive_ref_pic_marking_mode_flag = %d, want 0 (sliding window)", got)
	}
	if got := r.ue(); got != 0 {
		t.Fatalf("slice_qp_delta exp-golomb = %d, want se(0)", got)
	}
	if got := r.ue(); got != 1 {
		t.Fatalf("disable_deblocking_filter_idc = %d, want 1", got)
	}
	if got := r.ue(); got != prodMbs {
		t.Fatalf("mb_skip_run = %d, want %d: the slice must skip every macroblock of the picture", got, prodMbs)
	}
	if r.err != nil {
		t.Fatalf("the slice header ran out of bits: %v", r.err)
	}
}

func TestRepeatFramesAreProperlyEscaped(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)
	for i := 0; i < 64; i++ {
		frame := s.Repeat()
		if frame == nil {
			t.Fatalf("Repeat %d returned nothing: %s", i, s.Disabled())
		}
		payload := onlySlice(t, frame).Payload
		for j := 0; j+2 < len(payload); j++ {
			if payload[j] == 0 && payload[j+1] == 0 && payload[j+2] <= 3 {
				t.Fatalf("frame %d carries an unescaped %02x %02x %02x at byte %d, which a decoder reads as a start code",
					i, payload[j], payload[j+1], payload[j+2], j)
			}
		}
	}
}

func TestFrameNumAdvancesAndWraps(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)
	// The production SPS has log2_max_frame_num 15, so frame_num wraps at
	// 32768. Walk it all the way round: an off-by-one there is a stream
	// that decodes for nine minutes and then does not.
	want := uint32(1)
	for i := 0; i < 1<<15+5; i++ {
		frame := s.Repeat()
		if frame == nil {
			t.Fatalf("Repeat %d returned nothing: %s", i, s.Disabled())
		}
		if got := readFrameNum(t, onlySlice(t, frame).Payload); got != want {
			t.Fatalf("repeat %d carries frame_num %d, want %d", i, got, want)
		}
		want = (want + 1) % (1 << 15)
	}
}

func TestObserveRenumbersLaterSlicesByWhatWasInserted(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)

	// Nothing inserted yet: a real slice passes through untouched, bytes
	// and all.
	real1 := nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 2, 1))
	if got := s.Observe(real1, false); !bytes.Equal(got, real1) {
		t.Fatal("a slice was rewritten before anything had been inserted")
	}

	// Insert two frames, which take frame_num 2 and 3. The publisher's
	// next slice still says 2, and must be published as 4.
	for i := 0; i < 2; i++ {
		if s.Repeat() == nil {
			t.Fatalf("Repeat %d: %s", i, s.Disabled())
		}
	}
	real2 := nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 2, 2))
	out := s.Observe(real2, false)
	if got := readFrameNum(t, onlySlice(t, out).Payload); got != 4 {
		t.Fatalf("frame_num %d after two inserted frames, want 4: the decoder sees a gap otherwise", got)
	}
	if s.Rewritten() != 1 {
		t.Fatalf("Rewritten = %d, want 1", s.Rewritten())
	}

	// And the frame after THAT keeps the same offset.
	real3 := nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 2, 3))
	if got := readFrameNum(t, onlySlice(t, s.Observe(real3, false)).Payload); got != 5 {
		t.Fatalf("frame_num %d on the following slice, want 5", got)
	}

	// An IDR resets frame_num to zero by definition, so the offset goes
	// with it.
	s.Observe(idrAU(t, 0), true)
	real4 := nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 2, 1))
	if got := s.Observe(real4, false); !bytes.Equal(got, real4) {
		t.Fatal("slices are still being renumbered after an IDR")
	}
}

func TestRewritingSurvivesAFrameNumThatWraps(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)
	const max = 1 << 15
	// One inserted frame, then a publisher slice sitting on the last
	// frame_num before the wrap.
	if s.Repeat() == nil {
		t.Fatalf("Repeat: %s", s.Disabled())
	}
	au := nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 2, max-1))
	if got := readFrameNum(t, onlySlice(t, s.Observe(au, false)).Payload); got != 0 {
		t.Fatalf("frame_num %d, want 0: (32767 + 1) mod 32768", got)
	}
}

func TestRepeatRefusesBeforeAnyPictureAndAfterANonReferenceOne(t *testing.T) {
	s := prodSynth(t)
	if s.Available() || s.Repeat() != nil {
		t.Fatal("a repeat frame was offered before any picture had been observed: there is nothing to repeat")
	}
	s.Observe(idrAU(t, 0), true)
	if !s.Available() {
		t.Fatal("no repeat frame available after an IDR")
	}
	// A non-reference picture is not in reference list 0, so a repeat
	// after one would show the picture BEFORE it.
	s.Observe(nal.AppendAVCC(nil, sliceNAL(t, nal.TypeSlice, 0, 1)), false)
	if s.Available() || s.Repeat() != nil {
		t.Fatal("a repeat frame was offered after a non-reference picture, which would repeat the wrong frame")
	}
}

func TestParameterSetChangeStopsSynthesis(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)
	if s.Repeat() == nil {
		t.Fatal("no repeat frame on a healthy stream")
	}

	// Chrome's screen share ramping from 640x360 to 1280x720 -- the
	// 2026-09-16 production incident. A frame written for the old picture
	// size decodes to a different picture, so synthesis has to stop until
	// the owner rebuilds this type.
	sps, pps := prodSets(t)
	changed := append([]byte(nil), sps...)
	changed[len(changed)-1] ^= 0x01
	au := nal.AppendAVCC(nil, changed)
	au = nal.AppendAVCC(au, pps)
	au = nal.AppendAVCC(au, sliceNAL(t, nal.TypeIDR, 3, 0))
	s.Observe(au, true)

	if s.Repeat() != nil {
		t.Fatal("still synthesizing frames after the publisher's SPS changed")
	}
	if s.Disabled() == "" {
		t.Fatal("no reason recorded for stopping")
	}
}

func TestAdaptiveReferenceMarkingStopsSynthesis(t *testing.T) {
	s := prodSynth(t)
	s.Observe(idrAU(t, 0), true)

	var w bitWriter
	w.ue(0)
	w.ue(5)
	w.ue(0)
	w.bits(1, 15)
	w.bit(0) // num_ref_idx_active_override_flag
	w.bit(0) // ref_pic_list_modification_flag_l0
	w.bit(1) // adaptive_ref_pic_marking_mode_flag: mmco 5 would reset frame_num
	w.ue(5)
	w.ue(0)
	rbsp := w.trailing()
	payload := append([]byte{byte(2<<5) | byte(nal.TypeSlice)}, nal.EscapeRBSP(rbsp)...)
	s.Observe(nal.AppendAVCC(nil, payload), false)

	if s.Repeat() != nil {
		t.Fatal("still synthesizing after a slice carried reference marking commands this package does not model")
	}
}

// buildSPS/buildPPS make parameter sets with one field moved off what
// production sends, so each refusal in New can be provoked on its own.
func buildSPS(pocType, maxRefFrames uint32, frameMbsOnly bool) []byte {
	var w bitWriter
	w.bits(66, 8)   // profile_idc: baseline
	w.bits(0xC0, 8) // constraint flags
	w.bits(30, 8)   // level_idc
	w.ue(0)         // seq_parameter_set_id
	w.ue(11)        // log2_max_frame_num_minus4 -> 15
	w.ue(pocType)
	if pocType == 0 {
		w.ue(0) // log2_max_pic_order_cnt_lsb_minus4
	}
	w.ue(maxRefFrames)
	w.bit(0) // gaps_in_frame_num_value_allowed_flag
	w.ue(39) // pic_width_in_mbs_minus1 -> 640
	w.ue(22) // pic_height_in_map_units_minus1
	if frameMbsOnly {
		w.bit(1)
	} else {
		w.bit(0)
		w.bit(0) // mb_adaptive_frame_field_flag
	}
	w.bit(0) // direct_8x8_inference_flag
	w.bit(0) // frame_cropping_flag
	w.bit(0) // vui_parameters_present_flag
	return append([]byte{byte(3<<5) | byte(nal.TypeSPS)}, nal.EscapeRBSP(w.trailing())...)
}

func buildPPS(cabac, weightedPred bool, sliceGroups uint32) []byte {
	var w bitWriter
	w.ue(0) // pic_parameter_set_id
	w.ue(0) // seq_parameter_set_id
	if cabac {
		w.bit(1)
	} else {
		w.bit(0)
	}
	w.bit(0)              // bottom_field_pic_order_in_frame_present_flag
	w.ue(sliceGroups - 1) // num_slice_groups_minus1
	if sliceGroups > 1 {
		w.ue(0) // slice_group_map_type: interleaved
		w.ue(0) // run_length_minus1[0]
		w.ue(0) // run_length_minus1[1]
	}
	w.ue(0) // num_ref_idx_l0_default_active_minus1
	w.ue(0) // num_ref_idx_l1_default_active_minus1
	if weightedPred {
		w.bit(1)
	} else {
		w.bit(0)
	}
	w.bits(0, 2) // weighted_bipred_idc
	w.se(0)      // pic_init_qp_minus26
	w.se(0)      // pic_init_qs_minus26
	w.se(0)      // chroma_qp_index_offset
	w.bit(1)     // deblocking_filter_control_present_flag
	w.bit(0)     // constrained_intra_pred_flag
	w.bit(0)     // redundant_pic_cnt_present_flag
	return append([]byte{byte(3<<5) | byte(nal.TypePPS)}, nal.EscapeRBSP(w.trailing())...)
}

// Each of these is a stream whose repeat frame would be wrong, not merely
// hard: New has to say no, and the fragmenter then keeps the long parts it
// has always produced. Refusing is the safe direction, which is why they
// are tested one by one rather than trusted to a single happy path.
func TestNewRefusesStreamsItCannotWriteASliceFor(t *testing.T) {
	okSPS := buildSPS(2, 1, true)
	okPPS := buildPPS(false, false, 1)
	if _, err := New(okSPS, okPPS); err != nil {
		t.Fatalf("the baseline control case was refused: %v", err)
	}
	for _, tc := range []struct {
		name string
		sps  []byte
		pps  []byte
	}{
		{"CABAC slice data", okSPS, buildPPS(true, false, 1)},
		{"several slice groups", okSPS, buildPPS(false, false, 2)},
		{"weighted prediction", okSPS, buildPPS(false, true, 1)},
		{"pic_order_cnt_type 0", buildSPS(0, 1, true), okPPS},
		{"more than one reference frame", buildSPS(2, 3, true), okPPS},
		{"field coding", buildSPS(2, 1, false), okPPS},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.sps, tc.pps); err == nil {
				t.Fatal("accepted; a repeat frame written for this stream would decode to the wrong picture")
			}
		})
	}
}
