package cmaf

import "github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"

// TrackID is the CMAF track ID used throughout this muxer. One video track
// per remux session; audio muxing (a second track) is L1.3.
const TrackID = 1

// InitParams is what BuildInitSegment needs to describe the one video
// track this session carries.
type InitParams struct {
	// Timescale is the media timescale in ticks/second. The muxer runs
	// everything in the RTP clock rate (h264.ClockRate, 90000) so no PTS/DTS
	// rescaling is ever needed between depacketizer and mp4 boxes.
	Timescale uint32
	// SPS/PPS carry the NAL header byte, no length prefix and no start
	// code: exactly what the depacketizer hands back on AccessUnit.SPS/PPS.
	SPS []byte
	PPS []byte
}

// BuildInitSegment returns a CMAF initialization segment: `ftyp` followed
// by a `moov` describing one fragmented AVC video track, with no samples
// (they arrive in later `moof`/`mdat` fragments). Every following fragment
// in the session reuses this init segment; the player re-parses it once and
// then only reads fragments.
func BuildInitSegment(p InitParams) ([]byte, error) {
	if len(p.SPS) < 4 {
		return nil, errInitNeedsSPS
	}
	if len(p.PPS) < 1 {
		return nil, errInitNeedsPPS
	}
	info, err := nal.ParseSPS(p.SPS)
	if err != nil {
		return nil, err
	}
	if info.Width == 0 || info.Height == 0 {
		return nil, errInitBadDimensions
	}

	return concat(buildFtyp(), buildMoov(p.Timescale, info.Width, info.Height, p.SPS, p.PPS)), nil
}

func buildFtyp() []byte {
	body := concat(
		[]byte("iso5"), u32(1), // major_brand, minor_version
		[]byte("iso5"), []byte("iso6"), []byte("mp41"), // compatible_brands
	)
	return box("ftyp", body)
}

func buildMoov(timescale, width, height uint32, sps, pps []byte) []byte {
	return box("moov", concat(
		buildMvhd(timescale),
		buildTrak(timescale, width, height, sps, pps),
		buildMvex(),
	))
}

func buildMvhd(timescale uint32) []byte {
	body := concat(
		u32(0), u32(0), // creation_time, modification_time
		u32(timescale),
		u32(0),              // duration: unknown, this is a fragmented movie
		u32(0x00010000),     // rate 1.0
		u16(0x0100), u16(0), // volume 1.0, reserved
		u32(0), u32(0), // reserved
		identityMatrix(),
		u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
		u32(2), // next_track_ID
	)
	return fullBox("mvhd", 0, 0, body)
}

func buildTrak(timescale, width, height uint32, sps, pps []byte) []byte {
	return box("trak", concat(
		buildTkhd(width, height),
		buildMdia(timescale, width, height, sps, pps),
	))
}

func buildTkhd(width, height uint32) []byte {
	const flagsEnabledInMovieInPreview = 0x000007
	body := concat(
		u32(0), u32(0), // creation_time, modification_time
		u32(TrackID),
		u32(0),         // reserved
		u32(0),         // duration
		u32(0), u32(0), // reserved
		i16(0), i16(0), // layer, alternate_group
		i16(0), u16(0), // volume (0 for video), reserved
		identityMatrix(),
		u32(width<<16), u32(height<<16), // width/height, 16.16 fixed point
	)
	return fullBox("tkhd", 0, flagsEnabledInMovieInPreview, body)
}

func buildMdia(timescale, width, height uint32, sps, pps []byte) []byte {
	return box("mdia", concat(
		buildMdhd(timescale),
		buildHdlr(),
		buildMinf(width, height, sps, pps),
	))
}

func buildMdhd(timescale uint32) []byte {
	const languageUndetermined = 0x55C4 // packed ISO-639-2/T "und"
	body := concat(
		u32(0), u32(0), // creation_time, modification_time
		u32(timescale),
		u32(0), // duration: unknown
		u16(languageUndetermined),
		u16(0), // pre_defined
	)
	return fullBox("mdhd", 0, 0, body)
}

func buildHdlr() []byte {
	name := append([]byte("VideoHandler"), 0)
	body := concat(
		u32(0),                 // pre_defined
		[]byte("vide"),         // handler_type
		u32(0), u32(0), u32(0), // reserved
		name,
	)
	return fullBox("hdlr", 0, 0, body)
}

func buildMinf(width, height uint32, sps, pps []byte) []byte {
	return box("minf", concat(
		buildVmhd(),
		buildDinf(),
		buildStbl(width, height, sps, pps),
	))
}

func buildVmhd() []byte {
	const flagsAllPresentationModesLegal = 1
	body := concat(u16(0), u16(0), u16(0), u16(0)) // graphicsmode, opcolor r/g/b
	return fullBox("vmhd", 0, flagsAllPresentationModesLegal, body)
}

func buildDinf() []byte {
	const flagsSelfContained = 1
	urlBox := fullBox("url ", 0, flagsSelfContained, nil)
	dref := fullBox("dref", 0, 0, concat(u32(1), urlBox))
	return box("dinf", dref)
}

func buildStbl(width, height uint32, sps, pps []byte) []byte {
	return box("stbl", concat(
		buildStsd(width, height, sps, pps),
		fullBox("stts", 0, 0, u32(0)), // entry_count = 0: samples live in trun
		fullBox("stsc", 0, 0, u32(0)),
		fullBox("stsz", 0, 0, concat(u32(0), u32(0))), // sample_size, sample_count
		fullBox("stco", 0, 0, u32(0)),
	))
}

func buildStsd(width, height uint32, sps, pps []byte) []byte {
	entry := buildAvc1(width, height, sps, pps)
	return fullBox("stsd", 0, 0, concat(u32(1), entry))
}

func buildAvc1(width, height uint32, sps, pps []byte) []byte {
	compressorName := make([]byte, 32) // length-prefixed Pascal string, empty
	body := concat(
		u32(0), u16(0), // reserved(6 bytes) split as u32+u16
		u16(1),         // data_reference_index
		u16(0), u16(0), // pre_defined, reserved
		u32(0), u32(0), u32(0), // pre_defined[3]
		u16(uint16(width)), u16(uint16(height)),
		u32(0x00480000), u32(0x00480000), // h/v resolution, 72dpi
		u32(0), // reserved
		u16(1), // frame_count
		compressorName,
		u16(0x0018), // depth
		i16(-1),     // pre_defined
		buildAvcC(sps, pps),
	)
	return box("avc1", body)
}

// buildAvcC writes the AVCDecoderConfigurationRecord (ISO/IEC 14496-15
// §5.3.3.1) a player needs to configure its H.264 decoder before it can
// touch a single sample.
func buildAvcC(sps, pps []byte) []byte {
	profileIdc := sps[1]
	profileCompat := sps[2]
	levelIdc := sps[3]

	body := []byte{
		1, // configurationVersion
		profileIdc,
		profileCompat,
		levelIdc,
		0xFC | 3, // reserved(6)='111111', lengthSizeMinusOne(2)=3 (4-byte length)
	}
	body = append(body, 0xE0|1) // reserved(3)='111', numOfSequenceParameterSets(5)=1
	body = append(body, u16(uint16(len(sps)))...)
	body = append(body, sps...)
	body = append(body, 1) // numOfPictureParameterSets
	body = append(body, u16(uint16(len(pps)))...)
	body = append(body, pps...)

	if needsAvcCHighProfileExt(profileIdc) {
		body = append(body, 0xFC|1) // reserved(6), chroma_format=4:2:0
		body = append(body, 0xF8)   // reserved(5), bit_depth_luma_minus8=0
		body = append(body, 0xF8)   // reserved(5), bit_depth_chroma_minus8=0
		body = append(body, 0)      // numOfSequenceParameterSetExt
	}

	return box("avcC", body)
}

// needsAvcCHighProfileExt is ISO/IEC 14496-15 §5.3.3.1.2's own profile
// list, which is narrower than (and not to be confused with) the set of
// profiles whose *SPS* itself carries chroma/bit-depth fields
// (nal.hasChromaInfo): a High 4:2:2 stream (122) needs both, but this
// avcC extension is not written for every profile that has SPS chroma
// info.
func needsAvcCHighProfileExt(profileIdc uint8) bool {
	switch profileIdc {
	case 100, 110, 122, 144:
		return true
	default:
		return false
	}
}

func buildMvex() []byte {
	body := concat(
		u32(TrackID),
		u32(1),          // default_sample_description_index
		u32(0),          // default_sample_duration: always explicit in trun
		u32(0),          // default_sample_size: always explicit in trun
		u32(0x00010001), // default_sample_flags: non-sync, depends-on-others
	)
	return box("mvex", fullBox("trex", 0, 0, body))
}

type initError string

func (e initError) Error() string { return string(e) }

const (
	errInitNeedsSPS      = initError("cmaf: BuildInitSegment needs a non-empty SPS")
	errInitNeedsPPS      = initError("cmaf: BuildInitSegment needs a non-empty PPS")
	errInitBadDimensions = initError("cmaf: SPS parsed to a zero width or height")
)
