package nal

// SPSInfo is the handful of fields the CMAF init segment needs out of a
// sequence parameter set: the coded picture size for the `avc1` sample
// entry and the track header, plus the chroma/bit-depth fields `avcC`'s
// High-profile extension must carry (ISO/IEC 14496-15 §5.3.3.1.2) so the
// init segment never claims different decoder parameters than the SPS
// itself describes. Everything else in the SPS (VUI, timing, HRD) is left
// alone; passthrough never needs it.
type SPSInfo struct {
	Width  uint32
	Height uint32
	// ChromaFormatIDC, BitDepthLumaMinus8 and BitDepthChromaMinus8 default
	// to 1, 0 and 0 (4:2:0, 8-bit) when the bitstream does not carry them
	// at all (every profile below High) — that omission itself means
	// 4:2:0 8-bit per spec, not "unknown".
	ChromaFormatIDC      uint32
	BitDepthLumaMinus8   uint32
	BitDepthChromaMinus8 uint32
}

// ParseSPS reads a sequence parameter set (NAL header byte included, RBSP
// emulation-prevention bytes still in place, as it arrives off the wire) and
// returns its coded picture dimensions.
//
// This follows ITU-T H.264 §7.3.2.1.1 through frame_cropping; it does not
// parse VUI (timing/HRD), which the muxer does not need. Chroma format
// defaults to 4:2:0 (chroma_format_idc = 1), the value implied whenever the
// bitstream does not carry the field at all (every profile below High),
// which covers every encoder pqp has seen in a screen share.
func ParseSPS(payload []byte) (SPSInfo, error) {
	if len(payload) < 4 {
		return SPSInfo{}, errShortSPS
	}
	if Type(payload[0]&0x1F) != TypeSPS {
		return SPSInfo{}, errNotSPS
	}

	r := newBitReader(unescapeRBSP(payload[1:]))

	_ = r.u(8) // profile_idc
	_ = r.u(8) // constraint flags + reserved
	_ = r.u(8) // level_idc
	_ = r.ue() // seq_parameter_set_id

	profileIdc := payloadProfileIdc(payload)
	chromaFormatIdc := uint32(1)
	bitDepthLumaMinus8 := uint32(0)
	bitDepthChromaMinus8 := uint32(0)
	separateColourPlane := false
	if hasChromaInfo(profileIdc) {
		chromaFormatIdc = r.ue()
		if chromaFormatIdc == 3 {
			separateColourPlane = r.bit() == 1
		}
		bitDepthLumaMinus8 = r.ue()
		bitDepthChromaMinus8 = r.ue()
		_ = r.bit1()
		if r.bit() == 1 { // seq_scaling_matrix_present_flag
			count := 8
			if chromaFormatIdc == 3 {
				count = 12
			}
			for i := 0; i < count; i++ {
				if r.bit() == 1 { // seq_scaling_list_present_flag[i]
					size := 16
					if i >= 6 {
						size = 64
					}
					r.skipScalingList(size)
				}
			}
		}
	}

	_ = r.ue() // log2_max_frame_num_minus4
	picOrderCntType := r.ue()
	switch picOrderCntType {
	case 0:
		_ = r.ue() // log2_max_pic_order_cnt_lsb_minus4
	case 1:
		_ = r.bit1()
		_ = r.se()
		_ = r.se()
		n := r.ue()
		for i := uint32(0); i < n; i++ {
			_ = r.se()
		}
	}

	_ = r.ue() // max_num_ref_frames
	_ = r.bit1()

	picWidthInMbsMinus1 := r.ue()
	picHeightInMapUnitsMinus1 := r.ue()
	frameMbsOnly := r.bit()
	if frameMbsOnly == 0 {
		_ = r.bit1() // mb_adaptive_frame_field_flag
	}
	_ = r.bit1() // direct_8x8_inference_flag

	var cropLeft, cropRight, cropTop, cropBottom uint32
	if r.bit() == 1 { // frame_cropping_flag
		cropLeft = r.ue()
		cropRight = r.ue()
		cropTop = r.ue()
		cropBottom = r.ue()
	}
	if r.err != nil {
		return SPSInfo{}, r.err
	}

	subWidthC, subHeightC := uint32(2), uint32(2)
	if separateColourPlane || chromaFormatIdc == 0 {
		subWidthC, subHeightC = 1, 1
	} else if chromaFormatIdc == 3 {
		subWidthC, subHeightC = 1, 1
	}

	frameHeightInMbs := (2 - frameMbsOnly) * (picHeightInMapUnitsMinus1 + 1)
	width := (picWidthInMbsMinus1+1)*16 - subWidthC*(cropLeft+cropRight)
	height := frameHeightInMbs*16 - subHeightC*(2-frameMbsOnly)*(cropTop+cropBottom)

	return SPSInfo{
		Width:                width,
		Height:               height,
		ChromaFormatIDC:      chromaFormatIdc,
		BitDepthLumaMinus8:   bitDepthLumaMinus8,
		BitDepthChromaMinus8: bitDepthChromaMinus8,
	}, nil
}

func payloadProfileIdc(payload []byte) uint8 { return payload[1] }

func hasChromaInfo(profileIdc uint8) bool {
	switch profileIdc {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		return true
	default:
		return false
	}
}

// unescapeRBSP removes H.264 emulation-prevention bytes (0x03 following
// 0x00 0x00 when the next byte is 0x00, 0x01, 0x02 or 0x03) so the bit
// reader sees the raw RBSP the spec describes.
func unescapeRBSP(b []byte) []byte {
	out := make([]byte, 0, len(b))
	zeros := 0
	for i := 0; i < len(b); i++ {
		if zeros >= 2 && b[i] == 0x03 && i+1 < len(b) && b[i+1] <= 0x03 {
			zeros = 0
			continue
		}
		if b[i] == 0x00 {
			zeros++
		} else {
			zeros = 0
		}
		out = append(out, b[i])
	}
	return out
}

type bitReader struct {
	data []byte
	pos  int // bit position
	err  error
}

func newBitReader(b []byte) *bitReader { return &bitReader{data: b} }

func (r *bitReader) bit() uint32 {
	if r.err != nil {
		return 0
	}
	byteIdx := r.pos >> 3
	if byteIdx >= len(r.data) {
		r.err = errBitOverrun
		return 0
	}
	shift := 7 - uint(r.pos&7)
	v := (r.data[byteIdx] >> shift) & 1
	r.pos++
	return uint32(v)
}

// bit1 reads and discards a single flag bit; named to make call sites read
// as "one flag bit, value unused" rather than a bare bit() whose result is
// silently thrown away.
func (r *bitReader) bit1() uint32 { return r.bit() }

func (r *bitReader) u(n int) uint32 {
	var v uint32
	for i := 0; i < n; i++ {
		v = (v << 1) | r.bit()
	}
	return v
}

// ue reads an unsigned Exp-Golomb coded value (H.264 §9.1).
func (r *bitReader) ue() uint32 {
	leadingZeros := 0
	for r.bit() == 0 {
		leadingZeros++
		if r.err != nil || leadingZeros > 32 {
			return 0
		}
	}
	if leadingZeros == 0 {
		return 0
	}
	return (1 << uint(leadingZeros)) - 1 + r.u(leadingZeros)
}

// se reads a signed Exp-Golomb coded value (H.264 §9.1.1).
func (r *bitReader) se() int32 {
	k := r.ue()
	if k%2 == 0 {
		return -int32(k / 2)
	}
	return int32(k+1) / 2
}

// skipScalingList consumes a scaling_list() of the given size (16 or 64
// entries) without retaining the values: the muxer only needs to land on
// the correct bit offset for what follows (§7.3.2.1.1.1).
func (r *bitReader) skipScalingList(size int) {
	lastScale := int32(8)
	nextScale := int32(8)
	for j := 0; j < size; j++ {
		if nextScale != 0 {
			deltaScale := r.se()
			nextScale = (lastScale + deltaScale + 256) % 256
		}
		if nextScale != 0 {
			lastScale = nextScale
		}
	}
}

type spsError string

func (e spsError) Error() string { return string(e) }

const (
	errShortSPS   = spsError("nal: sps payload too short")
	errNotSPS     = spsError("nal: payload is not a sequence parameter set")
	errBitOverrun = spsError("nal: sps bitstream ended before parsing finished")
)
