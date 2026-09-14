package cmaf

// AudioInitParams describes the one AAC-LC audio track an audio-rendition
// session carries. Unlike BuildInitSegment (video), there is no SPS/PPS to
// parse: an AAC-LC AudioSpecificConfig is fully determined by sample rate
// and channel count, which internal/aacenc already fixes for the whole
// service (48kHz stereo), so this is a much smaller surface.
type AudioInitParams struct {
	// Timescale is the media timescale in ticks/second. Audio runs its own
	// track at aacenc.SampleRate (48000) rather than reusing the video
	// track's 90kHz RTP clock: this is a genuinely separate CMAF stream
	// (see the README's "Muxing: two renditions, not two tracks" for why),
	// and at 48000 a sample COUNT and its tfdt duration in ticks are the
	// same number, which is what keeps internal/pipeline's audio
	// fragmenter simple.
	Timescale uint32
	// SampleRate is the AAC stream's sample rate, written into the
	// AudioSpecificConfig's sampling frequency index. Must be one of the
	// nine rates ISO/IEC 14496-3 Table 1.6.3.4 defines an index for; 48000
	// (index 3) is the only one internal/aacenc ever produces today.
	SampleRate uint32
	// Channels is the AAC stream's channel count (ISO/IEC 14496-3 Table
	// 1.6.3.3's channelConfiguration): 1 or 2. internal/aacenc always
	// encodes 2 (stereo).
	Channels uint16
}

// BuildAudioInitSegment returns a CMAF initialization segment for one
// fragmented AAC-LC audio track: `ftyp` followed by a `moov` with no
// samples (they arrive in later `moof`/`mdat` fragments, from
// BuildFragment -- the same function the video track uses, since a moof's
// shape does not depend on the codec inside its mdat).
func BuildAudioInitSegment(p AudioInitParams) ([]byte, error) {
	asc, err := audioSpecificConfig(p.SampleRate, p.Channels)
	if err != nil {
		return nil, err
	}
	return concat(buildFtyp(), buildAudioMoov(p.Timescale, p.SampleRate, p.Channels, asc)), nil
}

func buildAudioMoov(timescale, sampleRate uint32, channels uint16, asc []byte) []byte {
	return box("moov", concat(
		buildMvhd(timescale),
		buildAudioTrak(timescale, sampleRate, channels, asc),
		buildMvex(),
	))
}

func buildAudioTrak(timescale, sampleRate uint32, channels uint16, asc []byte) []byte {
	return box("trak", concat(
		buildAudioTkhd(),
		buildAudioMdia(timescale, sampleRate, channels, asc),
	))
}

func buildAudioTkhd() []byte {
	const flagsEnabledInMovieInPreview = 0x000007
	body := concat(
		u32(0), u32(0), // creation_time, modification_time
		u32(TrackID),
		u32(0),         // reserved
		u32(0),         // duration
		u32(0), u32(0), // reserved
		i16(0), i16(0), // layer, alternate_group
		i16(0x0100), u16(0), // volume 1.0 (8.8 fixed point) for an audio track, reserved
		identityMatrix(),
		u32(0), u32(0), // width/height: none, this is audio
	)
	return fullBox("tkhd", 0, flagsEnabledInMovieInPreview, body)
}

func buildAudioMdia(timescale, sampleRate uint32, channels uint16, asc []byte) []byte {
	return box("mdia", concat(
		buildMdhd(timescale),
		buildAudioHdlr(),
		buildAudioMinf(sampleRate, channels, asc),
	))
}

func buildAudioHdlr() []byte {
	name := append([]byte("SoundHandler"), 0)
	body := concat(
		u32(0),                 // pre_defined
		[]byte("soun"),         // handler_type
		u32(0), u32(0), u32(0), // reserved
		name,
	)
	return fullBox("hdlr", 0, 0, body)
}

func buildAudioMinf(sampleRate uint32, channels uint16, asc []byte) []byte {
	return box("minf", concat(
		buildSmhd(),
		buildDinf(),
		buildAudioStbl(sampleRate, channels, asc),
	))
}

// buildSmhd is the sound-track analogue of buildVmhd: a "sound media
// header", balance centered (mono/stereo output, no explicit pan).
func buildSmhd() []byte {
	body := concat(i16(0), u16(0)) // balance, reserved
	return fullBox("smhd", 0, 0, body)
}

func buildAudioStbl(sampleRate uint32, channels uint16, asc []byte) []byte {
	return box("stbl", concat(
		buildAudioStsd(sampleRate, channels, asc),
		fullBox("stts", 0, 0, u32(0)),
		fullBox("stsc", 0, 0, u32(0)),
		fullBox("stsz", 0, 0, concat(u32(0), u32(0))),
		fullBox("stco", 0, 0, u32(0)),
	))
}

func buildAudioStsd(sampleRate uint32, channels uint16, asc []byte) []byte {
	entry := buildMp4a(sampleRate, channels, asc)
	return fullBox("stsd", 0, 0, concat(u32(1), entry))
}

// buildMp4a is the AAC sample entry (ISO/IEC 14496-14): the audio
// equivalent of buildAvc1. sampleRate is written as the classic 16.16
// fixed-point field every player still reads even though the real rate is
// what the `esds` AudioSpecificConfig carries.
func buildMp4a(sampleRate uint32, channels uint16, asc []byte) []byte {
	body := concat(
		u32(0), u16(0), // reserved(6 bytes)
		u16(1),         // data_reference_index
		u32(0), u32(0), // reserved
		u16(channels),
		u16(16),        // samplesize
		u16(0), u16(0), // pre_defined, reserved
		u32(sampleRate<<16), // samplerate, 16.16 fixed point
		buildEsds(asc),
	)
	return box("mp4a", body)
}

// buildEsds writes an `esds` box (ISO/IEC 14496-1 §7.2.6.5) carrying an
// MPEG-4 ES_Descriptor whose DecoderSpecificInfo is asc (the
// AudioSpecificConfig). This is the minimum a player needs to configure
// an AAC-LC decoder before it can touch a sample: without it, a `mp4a`
// entry names the general container format but not which of MPEG-4
// Audio's many object types and configurations this stream actually is.
//
// The descriptor tree here is deliberately the smallest one that is
// still well-formed MPEG-4 systems syntax (ISO/IEC 14496-1 §7.2.6): one
// ES_Descriptor, one DecoderConfigDescriptor (objectTypeIndication=0x40,
// MPEG-4 Audio; streamType=0x05, AudioStream), one DecoderSpecificInfo
// (the raw asc bytes), one minimal SLConfigDescriptor (predefined=2,
// "reserved for use in MP4 files", meaning no explicit SL packet header
// is used -- correct for samples that arrive as CMAF `mdat` entries, not
// as SL-packetized ES data).
func buildEsds(asc []byte) []byte {
	decoderSpecificInfo := descriptorTag(0x05, asc)

	const (
		objectTypeIndicationMPEG4Audio = 0x40
		streamTypeAudioFlag            = 0x05 << 2 // streamType=5 (AudioStream), upstream=0
		streamTypeReserved             = 0x01      // the reserved bit ISO/IEC 14496-1 sets to 1
		bufferSizeDB                   = 0         // unspecified; not required to be accurate for playback
		maxBitrate                     = 128000
		avgBitrate                     = 128000
	)
	decoderConfigBody := concat(
		[]byte{objectTypeIndicationMPEG4Audio, streamTypeAudioFlag | streamTypeReserved, 0, 0, bufferSizeDB},
		u32(maxBitrate),
		u32(avgBitrate),
		decoderSpecificInfo,
	)
	decoderConfigDescriptor := descriptorTag(0x04, decoderConfigBody)

	slConfigDescriptor := descriptorTag(0x06, []byte{0x02}) // predefined = 2

	esDescriptorBody := concat(
		u16(0),    // ES_ID (0: this track supplies its own via the trak, not the descriptor)
		[]byte{0}, // flags: streamDependenceFlag/URL_Flag/OCRstreamFlag=0, streamPriority=0
		decoderConfigDescriptor,
		slConfigDescriptor,
	)
	esDescriptor := descriptorTag(0x03, esDescriptorBody)

	return fullBox("esds", 0, 0, esDescriptor)
}

// descriptorTag wraps body in an MPEG-4 descriptor: a 1-byte tag followed
// by the ISO/IEC 14496-1 §8.3.3 variable-length size (big-endian base-128,
// continuation bit set on every byte but the last; every size this file
// ever builds is under 128 bytes, so this always emits exactly one size
// byte, but the multi-byte form is implemented anyway since a hardcoded
// one-byte assumption would silently truncate the moment a larger
// DecoderConfigDescriptor ever needed to fit here).
func descriptorTag(tag byte, body []byte) []byte {
	return concat([]byte{tag}, encodeDescriptorLength(len(body)), body)
}

func encodeDescriptorLength(n int) []byte {
	if n < 0 {
		panic("cmaf: negative descriptor length")
	}
	// Base-128, most significant group first, continuation bit (0x80) set
	// on every byte except the last.
	var groups []byte
	groups = append(groups, byte(n&0x7F))
	n >>= 7
	for n > 0 {
		groups = append(groups, byte(n&0x7F)|0x80)
		n >>= 7
	}
	// groups was built least-significant-group first; reverse it.
	out := make([]byte, len(groups))
	for i, g := range groups {
		out[len(groups)-1-i] = g
	}
	return out
}

// audioObjectTypeAACLC / mpeg4SamplingFrequencyIndex implement enough of
// ISO/IEC 14496-3 Table 1.6.3 to build an AudioSpecificConfig for the
// exact rates internal/aacenc can ever produce (48000, matching
// aacenc.SampleRate) plus every other standard MPEG-4 rate, so this
// function is not silently wrong the day a config option changes the
// encoder's sample rate.
const audioObjectTypeAACLC = 2

var mpeg4SamplingFrequencies = [...]uint32{
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350,
}

func mpeg4SamplingFrequencyIndex(rate uint32) (int, bool) {
	for i, r := range mpeg4SamplingFrequencies {
		if r == rate {
			return i, true
		}
	}
	return 0, false
}

// audioSpecificConfig builds the 2-byte ISO/IEC 14496-3 §1.6.2.1
// AudioSpecificConfig for plain AAC-LC, no SBR/PS extension (ffmpeg's
// native encoder does not add one at these bitrates): 5 bits object type,
// 4 bits sampling frequency index, 4 bits channel configuration, then a
// 3-bit padding to the next byte boundary (GASpecificConfig's
// frameLengthFlag=0, dependsOnCoreCoder=0, extensionFlag=0 -- the standard
// all-zero tail for a plain AAC-LC stream with no SBR).
func audioSpecificConfig(sampleRate uint32, channels uint16) ([]byte, error) {
	if channels != 1 && channels != 2 {
		return nil, errAudioInitBadChannels
	}
	idx, ok := mpeg4SamplingFrequencyIndex(sampleRate)
	if !ok {
		return nil, errAudioInitBadSampleRate
	}
	b0 := byte(audioObjectTypeAACLC<<3) | byte(idx>>1)
	b1 := byte(idx&0x01)<<7 | byte(channels)<<3
	return []byte{b0, b1}, nil
}

const (
	errAudioInitBadChannels   = initError("cmaf: BuildAudioInitSegment needs Channels == 1 or 2")
	errAudioInitBadSampleRate = initError("cmaf: BuildAudioInitSegment's SampleRate has no MPEG-4 sampling frequency index")
)
