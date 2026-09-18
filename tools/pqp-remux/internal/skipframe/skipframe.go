// Package skipframe synthesizes H.264 access units that repeat the last
// decoded picture, and keeps the frame_num sequence gapless around them.
//
// WHY A REPEAT FRAME EXISTS AT ALL. Every part boundary in
// internal/pipeline is decided by an access unit's arrival, so a part
// lasts exactly as long as the frame it holds. A presenter whose encoder
// sends nothing for two seconds (a static Chrome tab, a dropped frame, a
// brief stall) therefore produces a two-second part, and Apple's player
// refuses the whole playlist for it: "Partial Segment duration exceeds
// PART-TARGET" and, for the short part beside it, "non-terminal partial
// segment duration must be at least 85% of PART-TARGET". Both are fatal
// playlist parse errors, measured against the live stream with AVPlayer
// on 2026-09-17. A part can only be cut on the clock instead of on the
// source if something fills the rest of the gap, and the only thing that
// can fill it without inventing picture content is a frame that says
// "the picture did not change".
//
// WHAT IT PRODUCES. One P slice per frame, first_mb_in_slice 0,
// mb_skip_run = PicSizeInMbs: every macroblock is P_Skip. A P_Skip
// macroblock whose neighbours are all skipped derives a zero motion
// vector (§8.4.1.1: mvSkip is forced to zero when mbA/mbB are
// unavailable or themselves zero with refIdx 0), so by induction the
// whole picture is copied from reference index 0 with no residual and no
// interpolation — a bit-exact repeat of the previous picture. The slice
// also disables the deblocking filter where the PPS allows it to, so
// nothing can touch the copied samples even in principle.
//
// WHY IT IS A REFERENCE FRAME, AND WHAT THAT COSTS. A NON-reference
// repeat would need no bookkeeping at all (frame_num does not advance
// over one), but with pic_order_cnt_type 2 — which is what every Chrome
// screen share this pipeline has captured uses — two consecutive
// non-reference frames derive the SAME picture order count, which the
// standard forbids precisely because output order stops being defined.
// A two-second gap needs three of them in a row. So the repeat is a
// reference frame: frame_num advances, POC follows it, and every
// subsequent real slice's frame_num has to be renumbered by however many
// frames we inserted (Rewrite, below) or the decoder sees a gap in a
// stream whose SPS says gaps are not allowed.
//
// WHY max_num_ref_frames MUST BE 1. Inserting a reference picture runs
// the sliding-window marking process, which evicts the OLDEST short-term
// reference. With one reference frame the evicted picture is exactly the
// one our frame is a copy of, so list 0 index 0 still holds those
// samples and a following real P frame predicts from what its encoder
// intended. With more, the eviction shifts every other list entry and a
// multi-reference P frame would predict from the wrong picture. New
// refuses such a stream rather than guess.
package skipframe

import (
	"bytes"
	"fmt"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// refIdc is the nal_ref_idc a synthesized frame carries. Any non-zero
// value marks the picture as a reference; 2 is what OpenH264 stamps on an
// ordinary P frame, so a synthesized frame looks like its neighbours to
// anything that inspects the header byte.
const refIdc = 2

// pSliceAllP is slice_type 5: a P slice, asserting that every slice of
// this picture is a P slice — true by construction, since a synthesized
// picture is exactly one slice covering every macroblock.
const pSliceAllP = 5

// Synth builds repeat frames for one parameter-set pair and tracks the
// frame_num bookkeeping they force on the real slices that follow.
//
// Not safe for concurrent use; one Synth per video track, owned by the
// fragmenter that inserts the frames.
type Synth struct {
	sps nal.SPSInfo
	pps nal.PPSInfo
	// spsNAL/ppsNAL are the exact parameter set bytes this Synth was
	// built from, kept to catch a stream that changes them under it --
	// see Observe. THIS IS NOT THEORETICAL: Chrome's screen-share
	// encoder starts at 640x360 and ramps to 1280x720 a second or two
	// later (the 2026-09-16 production incident that made
	// session.handleParameterSetChange exist), and the first run of this
	// package's bitstream test against a real capture from R2 caught
	// exactly that: repeats written with the 40x23 macroblock count of
	// the first SPS decoded to a different picture once the stream was
	// 80x45. The owner rebuilds this type on a parameter-set change;
	// this check is the backstop for the day somebody forgets.
	spsNAL []byte
	ppsNAL []byte

	maxFrameNum uint32

	// delta is how many frames this Synth has inserted since the last
	// IDR, and therefore what every following real slice's frame_num is
	// renumbered by. An IDR resets frame_num to zero by definition, so
	// it resets this too.
	delta uint32
	// prevRefFrameNum is the frame_num, as PUBLISHED (renumbered), of
	// the last reference picture; a repeat frame takes the next value
	// after it. prevWasRef says whether the last picture of any kind was
	// a reference picture: a repeat frame copies list 0 index 0, which
	// is the last REFERENCE picture, so repeating after a non-reference
	// picture would show the wrong frame and is refused.
	prevRefFrameNum uint32
	prevWasRef      bool
	seenPicture     bool

	// disabled, once set, stops synthesis for the rest of the session
	// and says why. Rewriting continues regardless: frames already
	// inserted still have to be numbered around.
	disabled string

	inserted  uint64
	rewritten uint64
}

// New returns a Synth for the given parameter sets (raw NAL units, header
// byte included, exactly as they arrive in-band and as the init segment
// stores them), or an error naming the one property of the stream that
// makes a repeat frame unsafe to write. Every such error is a reason to
// keep today's behaviour (a part that runs long), never a reason to fail
// a session.
func New(sps, pps []byte) (*Synth, error) {
	si, err := nal.ParseSPS(sps)
	if err != nil {
		return nil, fmt.Errorf("skipframe: sps: %w", err)
	}
	pi, err := nal.ParsePPS(pps)
	if err != nil {
		return nil, fmt.Errorf("skipframe: pps: %w", err)
	}
	switch {
	case pi.EntropyCodingMode:
		// A CABAC slice's mb_skip_flag is arithmetic-coded, which means
		// writing one means running an arithmetic encoder. Baseline
		// (what WebRTC negotiates) is CAVLC.
		return nil, fmt.Errorf("skipframe: stream is CABAC; only CAVLC slice data is synthesized")
	case pi.NumSliceGroups != 1:
		return nil, fmt.Errorf("skipframe: %d slice groups; only one is synthesized", pi.NumSliceGroups)
	case pi.WeightedPred:
		return nil, fmt.Errorf("skipframe: weighted prediction is on; a skip slice would have to carry a weight table")
	case si.SeparateColourPlane:
		return nil, fmt.Errorf("skipframe: separate colour planes are not synthesized")
	case !si.FrameMbsOnly:
		return nil, fmt.Errorf("skipframe: field coding is not synthesized")
	case si.PicOrderCntType != 2:
		// See the package comment: types 0 and 1 carry POC in the slice
		// header, so inserting frames means renumbering the POC of
		// every following slice as well, and (for type 0) there is not
		// necessarily room between two real values to put one.
		return nil, fmt.Errorf("skipframe: pic_order_cnt_type %d; only type 2 is synthesized", si.PicOrderCntType)
	case si.MaxNumRefFrames != 1:
		return nil, fmt.Errorf("skipframe: max_num_ref_frames %d; only 1 keeps reference list 0 correct across an inserted frame", si.MaxNumRefFrames)
	case si.PicSizeInMbs() == 0:
		return nil, fmt.Errorf("skipframe: sps describes a zero-macroblock picture")
	case si.Log2MaxFrameNum < 4 || si.Log2MaxFrameNum > 16:
		return nil, fmt.Errorf("skipframe: log2_max_frame_num %d out of range", si.Log2MaxFrameNum)
	}
	return &Synth{
		sps:         si,
		pps:         pi,
		spsNAL:      append([]byte(nil), sps...),
		ppsNAL:      append([]byte(nil), pps...),
		maxFrameNum: 1 << si.Log2MaxFrameNum,
	}, nil
}

// Inherit carries the frame_num bookkeeping of a Synth being replaced
// (because the publisher's parameter sets changed) into its replacement,
// so real slices keep being renumbered by however many frames the old one
// had already inserted. An IDR resets all of it anyway, and a
// parameter-set change all but always arrives on one -- this exists for
// the case where it does not.
func (s *Synth) Inherit(prev *Synth) {
	if prev == nil {
		return
	}
	s.delta = prev.delta
	s.prevRefFrameNum = prev.prevRefFrameNum % s.maxFrameNum
	s.prevWasRef = prev.prevWasRef
	s.seenPicture = prev.seenPicture
	s.inserted = prev.inserted
	s.rewritten = prev.rewritten
}

// Observe takes every REAL access unit, in decode order, as it becomes a
// sample, and returns the AVCC bytes to store: au's own bytes while
// nothing has been inserted, a renumbered copy once something has. It
// must be called exactly once per access unit, AFTER any repeat frames
// that precede it have been taken from Repeat, so the renumbering counts
// them.
func (s *Synth) Observe(avcc []byte, isIDR bool) []byte {
	units, err := nal.ParseAVCC(avcc)
	if err != nil {
		s.disable("access unit is not parseable AVCC: " + err.Error())
		return avcc
	}
	// The parameter sets are checked on EVERY access unit, IDR included
	// -- an IDR is precisely where new ones arrive.
	for _, u := range units {
		switch {
		case u.Type == nal.TypeSPS && !bytes.Equal(u.Payload, s.spsNAL):
			s.disable("the publisher's SPS changed under a synthesizer built for the previous one")
		case u.Type == nal.TypePPS && !bytes.Equal(u.Payload, s.ppsNAL):
			s.disable("the publisher's PPS changed under a synthesizer built for the previous one")
		}
	}

	if isIDR {
		// An IDR restarts frame_num at zero and empties the reference
		// list, so everything this type tracks starts again with it.
		s.delta = 0
		s.prevRefFrameNum = 0
		s.prevWasRef = true
		s.seenPicture = true
		return avcc
	}

	rewrite := s.delta != 0
	out := avcc
	if rewrite {
		out = make([]byte, 0, len(avcc)+len(units))
	}
	for _, u := range units {
		payload := u.Payload
		if u.Type == nal.TypeSlice {
			hdr, err := s.readSliceHeader(payload)
			if err != nil {
				s.disable("slice header: " + err.Error())
			} else {
				if hdr.adaptiveMarking {
					// Reference marking commands are relative to the
					// current picture number, so an inserted frame does
					// not invalidate them — except mmco 5, which resets
					// frame_num outright and would leave this type's
					// bookkeeping describing a stream that no longer
					// exists. Rather than model a command WebRTC does
					// not send, stop inserting.
					s.disable("slice uses adaptive reference picture marking")
				}
				renumbered := (hdr.frameNum + s.delta) % s.maxFrameNum
				if u.RefIdc != 0 {
					s.prevRefFrameNum = renumbered
				}
				s.prevWasRef = u.RefIdc != 0
				s.seenPicture = true
				if rewrite {
					patched, perr := patchFrameNum(payload, hdr, renumbered, s.sps.Log2MaxFrameNum)
					if perr != nil {
						s.disable("rewriting frame_num: " + perr.Error())
					} else {
						payload = patched
						s.rewritten++
					}
				}
			}
		}
		if rewrite {
			out = nal.AppendAVCC(out, payload)
		}
	}
	return out
}

// Repeat returns one synthesized access unit in AVCC form, repeating the
// last picture Observe saw, or nil when this stream cannot be repeated
// (see New's refusals, and disable) or when no reference picture has been
// observed yet. Each call is a distinct picture: the caller must use
// every frame it takes, in order.
func (s *Synth) Repeat() []byte {
	if s.disabled != "" || !s.seenPicture || !s.prevWasRef {
		return nil
	}
	frameNum := (s.prevRefFrameNum + 1) % s.maxFrameNum
	nalu := s.buildSkipSlice(frameNum)
	s.prevRefFrameNum = frameNum
	s.prevWasRef = true
	s.delta++
	s.inserted++
	return nal.AppendAVCC(nil, nalu)
}

// Available reports whether Repeat would return a frame right now.
func (s *Synth) Available() bool { return s.disabled == "" && s.seenPicture && s.prevWasRef }

// Disabled returns why synthesis stopped, or "" while it is available.
func (s *Synth) Disabled() string { return s.disabled }

// Inserted and Rewritten are the two counters worth a stats line: frames
// synthesized, and real slices renumbered because of them.
func (s *Synth) Inserted() uint64  { return s.inserted }
func (s *Synth) Rewritten() uint64 { return s.rewritten }

func (s *Synth) disable(reason string) {
	if s.disabled == "" {
		s.disabled = reason
	}
}

// buildSkipSlice writes one whole-picture P_Skip slice NAL (header byte
// included, no length prefix). Every field below is either fixed by the
// picture being a single all-skip slice or copied from the parameter
// sets; the order is ITU-T H.264 §7.3.3 (slice_header) followed by
// §7.3.4 (slice_data) for a CAVLC P slice.
func (s *Synth) buildSkipSlice(frameNum uint32) []byte {
	var w bitWriter
	w.ue(0)                                      // first_mb_in_slice
	w.ue(pSliceAllP)                             // slice_type
	w.ue(s.pps.ID)                               // pic_parameter_set_id
	w.bits(frameNum, int(s.sps.Log2MaxFrameNum)) // frame_num
	// frame_mbs_only_flag is 1 (New refuses otherwise), so no
	// field_pic_flag; this is not an IDR, so no idr_pic_id; POC type is
	// 2 (New refuses otherwise), so no pic_order_cnt_lsb and no
	// delta_pic_order_cnt.
	if s.pps.RedundantPicCntPresent {
		w.ue(0) // redundant_pic_cnt
	}
	w.bit(0) // num_ref_idx_active_override_flag: the PPS default is enough for index 0
	w.bit(0) // ref_pic_list_modification_flag_l0: default order, so index 0 is the newest reference
	// weighted_pred_flag is 0 (New refuses otherwise), so no
	// pred_weight_table.
	w.bit(0) // adaptive_ref_pic_marking_mode_flag: sliding window, which with
	//          max_num_ref_frames 1 evicts exactly the picture this frame copies
	// entropy_coding_mode_flag is 0 (New refuses otherwise), so no
	// cabac_init_idc.
	w.se(0) // slice_qp_delta: no residual is coded, so QP is immaterial
	if s.pps.DeblockingFilterControlPresent {
		// Disable the loop filter for this picture. All-skip macroblocks
		// already give every edge a boundary strength of zero, so this
		// changes no sample; it removes the question rather than relying
		// on the derivation.
		w.ue(1) // disable_deblocking_filter_idc
	}
	// num_slice_groups is 1 (New refuses otherwise), so no
	// slice_group_change_cycle.
	w.ue(s.sps.PicSizeInMbs()) // mb_skip_run: skip every macroblock
	// more_rbsp_data() is false after that run, which ends slice_data.
	rbsp := w.trailing()

	out := make([]byte, 0, len(rbsp)+2)
	out = append(out, byte(refIdc<<5)|byte(nal.TypeSlice))
	return append(out, nal.EscapeRBSP(rbsp)...)
}

// sliceHeader is the part of a non-IDR slice header this package reads:
// where frame_num sits (so it can be rewritten in place) and whether the
// picture carries reference marking commands.
type sliceHeader struct {
	frameNum uint32
	// frameNumBit is frame_num's bit offset within the UNESCAPED rbsp
	// that follows the NAL header byte.
	frameNumBit int
	// rbsp is that unescaped payload, kept so a rewrite does not
	// unescape twice.
	rbsp            []byte
	adaptiveMarking bool
}

// readSliceHeader parses a non-IDR slice header far enough to find
// frame_num and dec_ref_pic_marking. It assumes the parameter-set
// restrictions New enforces (CAVLC, one slice group, no weighted
// prediction, frame macroblocks only, POC type 2); anything outside that
// is refused before a Synth exists.
func (s *Synth) readSliceHeader(payload []byte) (sliceHeader, error) {
	if len(payload) < 2 {
		return sliceHeader{}, fmt.Errorf("slice payload too short")
	}
	refIdcOfSlice := (payload[0] >> 5) & 0x03
	rbsp := nal.UnescapeRBSP(payload[1:])
	r := newBitReader(rbsp)

	_ = r.ue() // first_mb_in_slice
	sliceType := r.ue() % 5
	_ = r.ue() // pic_parameter_set_id
	bit := r.pos
	frameNum := r.bits(int(s.sps.Log2MaxFrameNum))
	if r.err != nil {
		return sliceHeader{}, r.err
	}
	h := sliceHeader{frameNum: frameNum, frameNumBit: bit, rbsp: rbsp}
	if refIdcOfSlice == 0 {
		// No dec_ref_pic_marking at all on a non-reference slice, and
		// nothing further this package needs.
		return h, nil
	}
	if s.pps.RedundantPicCntPresent {
		_ = r.ue() // redundant_pic_cnt
	}
	switch sliceType {
	case 0: // P
		if r.bit() == 1 { // num_ref_idx_active_override_flag
			_ = r.ue() // num_ref_idx_l0_active_minus1
		}
		if r.bit() == 1 { // ref_pic_list_modification_flag_l0
			for {
				idc := r.ue()
				if idc == 3 || r.err != nil {
					break
				}
				_ = r.ue()
			}
		}
	case 2: // I
	default:
		// B and SP/SI slices carry list 1 syntax this package does not
		// model. Baseline (what New has already limited us to by
		// refusing CABAC and weighted prediction) has none of them, so
		// treat one as a stream we do not understand.
		return h, fmt.Errorf("unexpected slice_type %d", sliceType)
	}
	h.adaptiveMarking = r.bit() == 1 // adaptive_ref_pic_marking_mode_flag
	if r.err != nil {
		return sliceHeader{}, r.err
	}
	return h, nil
}

// patchFrameNum returns the slice NAL with frame_num replaced by value.
// The field is fixed-width, so the RBSP keeps its length and only the
// emulation prevention has to be redone; EscapeRBSP's own comment covers
// why re-escaping is faithful.
func patchFrameNum(payload []byte, h sliceHeader, value uint32, width uint32) ([]byte, error) {
	rbsp := append([]byte(nil), h.rbsp...)
	if err := writeBitsAt(rbsp, h.frameNumBit, value, int(width)); err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(payload)+4)
	out = append(out, payload[0])
	return append(out, nal.EscapeRBSP(rbsp)...), nil
}
