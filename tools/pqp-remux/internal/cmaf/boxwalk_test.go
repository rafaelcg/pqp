package cmaf

import (
	"encoding/binary"
	"fmt"
)

// parsedBox is a minimal, test-only ISOBMFF box view: enough to walk the
// boxes this muxer emits and assert their structure without pulling in a
// parsing library the tests would then have to trust instead of verifying.
type parsedBox struct {
	Type string
	Body []byte // box contents, header stripped (still includes version/flags for a FullBox)
}

// parseBoxes splits buf into consecutive top-level boxes. It requires every
// byte of buf to belong to exactly one box (no trailing garbage, no
// overrun), which is itself part of what "box sizes are right" means.
func parseBoxes(buf []byte) ([]parsedBox, error) {
	var out []parsedBox
	for len(buf) > 0 {
		if len(buf) < 8 {
			return nil, fmt.Errorf("boxwalk: %d trailing bytes too short for a box header", len(buf))
		}
		size := binary.BigEndian.Uint32(buf[0:4])
		typ := string(buf[4:8])
		if size < 8 {
			return nil, fmt.Errorf("boxwalk: box %q declares size %d, smaller than its own header", typ, size)
		}
		if uint64(size) > uint64(len(buf)) {
			return nil, fmt.Errorf("boxwalk: box %q declares size %d, longer than the %d bytes remaining", typ, size, len(buf))
		}
		out = append(out, parsedBox{Type: typ, Body: buf[8:size]})
		buf = buf[size:]
	}
	return out, nil
}

func findBox(boxes []parsedBox, typ string) (parsedBox, bool) {
	for _, b := range boxes {
		if b.Type == typ {
			return b, true
		}
	}
	return parsedBox{}, false
}

// fullBoxFields splits a FullBox's body into (version, flags, remaining
// fields) the way every mvhd/tkhd/mdhd/tfhd/tfdt/trun/mfhd/stsd/... box in
// this muxer is shaped.
func fullBoxFields(body []byte) (version uint8, flags uint32, rest []byte) {
	version = body[0]
	flags = uint32(body[1])<<16 | uint32(body[2])<<8 | uint32(body[3])
	rest = body[4:]
	return
}
