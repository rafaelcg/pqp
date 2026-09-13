// Package nal parses H.264 Annex B / AVCC NAL unit streams far enough to
// support CMAF passthrough muxing: it never touches slice data, only the
// NAL header byte and, for SPS/PPS, the raw payload the muxer needs to build
// an avcC box.
package nal

import "encoding/binary"

// Type is an H.264 nal_unit_type (ITU-T H.264 §7.4.1, 5 bits).
type Type uint8

const (
	TypeUnspecified   Type = 0
	TypeSlice         Type = 1 // non-IDR slice (P/B)
	TypeSliceDPA      Type = 2
	TypeSliceDPB      Type = 3
	TypeSliceDPC      Type = 4
	TypeIDR           Type = 5
	TypeSEI           Type = 6
	TypeSPS           Type = 7
	TypePPS           Type = 8
	TypeAUD           Type = 9
	TypeEndOfSequence Type = 10
	TypeEndOfStream   Type = 11
	TypeFiller        Type = 12
	TypeSPSExt        Type = 13
)

// Unit is one NAL unit as seen inside an AVCC (4-byte big-endian length
// prefixed) byte stream, the format pion/rtp's H264Packet depacketizer
// produces when told IsAVC = true and the format CMAF samples want in the
// mdat box (ISO/IEC 14496-15 §5.2.3). Payload excludes the length prefix and
// includes the 1-byte NAL header.
type Unit struct {
	Type    Type
	RefIdc  uint8
	Payload []byte // header byte + RBSP, length-prefix stripped
}

// IsIDR reports whether the unit is a coded slice of an IDR picture.
func (u Unit) IsIDR() bool { return u.Type == TypeIDR }

// IsSPS reports whether the unit is a sequence parameter set.
func (u Unit) IsSPS() bool { return u.Type == TypeSPS }

// IsPPS reports whether the unit is a picture parameter set.
func (u Unit) IsPPS() bool { return u.Type == TypePPS }

// IsSlice reports whether the unit carries picture data (IDR or non-IDR),
// i.e. it is the kind of NAL a decoder actually decodes, as opposed to
// SPS/PPS/SEI/AUD/filler bookkeeping.
func (u Unit) IsSlice() bool {
	switch u.Type {
	case TypeSlice, TypeSliceDPA, TypeSliceDPB, TypeSliceDPC, TypeIDR:
		return true
	default:
		return false
	}
}

// ParseAVCC splits a length-prefixed AVCC byte stream into its NAL units.
// It returns an error only on a truncated length prefix or a length that
// runs past the end of buf; malformed RBSP inside a unit is left for the
// muxer/decoder, not this parser.
func ParseAVCC(buf []byte) ([]Unit, error) {
	var units []Unit
	for len(buf) > 0 {
		if len(buf) < 4 {
			return nil, errShort
		}
		size := binary.BigEndian.Uint32(buf[:4])
		buf = buf[4:]
		if uint64(size) > uint64(len(buf)) {
			return nil, errShort
		}
		payload := buf[:size]
		buf = buf[size:]
		if len(payload) == 0 {
			continue
		}
		units = append(units, Unit{
			Type:    Type(payload[0] & 0x1F),
			RefIdc:  (payload[0] >> 5) & 0x03,
			Payload: payload,
		})
	}
	return units, nil
}

// AppendAVCC appends one NAL unit (header byte included, no length prefix
// and no start code) to buf as a 4-byte length prefixed AVCC record, the
// shape avcC-boxed samples require.
func AppendAVCC(buf []byte, nalu []byte) []byte {
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(nalu)))
	buf = append(buf, lenBuf[:]...)
	buf = append(buf, nalu...)
	return buf
}

type parseError string

func (e parseError) Error() string { return string(e) }

const errShort = parseError("nal: truncated AVCC length prefix or size past end of buffer")
