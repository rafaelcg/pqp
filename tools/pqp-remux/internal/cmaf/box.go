// Package cmaf builds CMAF (fragmented MP4) init segments and fragments
// directly, one ISOBMFF box at a time, for H.264 passthrough: no decode, no
// transcode, the RTP-depacketized AVCC sample bytes go straight into an
// `mdat`. It is deliberately small and hand-rolled (see the PR description
// for why, over a general-purpose muxing library) so every box's shape is
// visible and testable in one file per box family.
package cmaf

import "encoding/binary"

// box builds a full ISOBMFF box: a 4-byte big-endian size (this box's total
// size, size field included), a 4-byte ASCII type, then body verbatim. It
// never emits the 64-bit "largesize" form; nothing this muxer writes
// approaches 4 GiB in one box.
func box(boxType string, body []byte) []byte {
	if len(boxType) != 4 {
		panic("cmaf: box type must be exactly 4 characters, got " + boxType)
	}
	out := make([]byte, 8+len(body))
	binary.BigEndian.PutUint32(out[0:4], uint32(8+len(body)))
	copy(out[4:8], boxType)
	copy(out[8:], body)
	return out
}

// fullBox is box() with the version/flags header ISOBMFF "full boxes"
// (mvhd, tkhd, mdhd, tfhd, tfdt, trun, ...) carry ahead of their body.
func fullBox(boxType string, version uint8, flags uint32, body []byte) []byte {
	head := make([]byte, 4)
	head[0] = version
	head[1] = byte(flags >> 16)
	head[2] = byte(flags >> 8)
	head[3] = byte(flags)
	return box(boxType, append(head, body...))
}

// concat joins already-built boxes into a parent box's body.
func concat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func u16(v uint16) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, v)
	return b
}

func u32(v uint32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return b
}

func u64(v uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, v)
	return b
}

func i16(v int16) []byte { return u16(uint16(v)) }

// identityMatrix is the ISOBMFF unity transformation matrix (8.4-format
// fixed point, per §5.3.4), used by both mvhd and tkhd.
func identityMatrix() []byte {
	return concat(
		u32(0x00010000), u32(0), u32(0),
		u32(0), u32(0x00010000), u32(0),
		u32(0), u32(0), u32(0x40000000),
	)
}
