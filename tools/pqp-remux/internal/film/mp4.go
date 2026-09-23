package film

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// The two numbers the timeline needs out of CMAF, read with a box walk
// small enough to not need a library (internal/cmaf writes these same boxes
// by hand, for the same reason).

var errBoxNotFound = errors.New("film: box not found")

// childBoxes calls fn for every box directly inside data. Stops early when
// fn returns false.
func childBoxes(data []byte, fn func(kind string, payload []byte) bool) error {
	for len(data) >= 8 {
		size := uint64(binary.BigEndian.Uint32(data[0:4]))
		kind := string(data[4:8])
		header := uint64(8)
		switch size {
		case 0:
			size = uint64(len(data))
		case 1:
			if len(data) < 16 {
				return fmt.Errorf("film: truncated large box %q", kind)
			}
			size = binary.BigEndian.Uint64(data[8:16])
			header = 16
		}
		if size < header {
			return fmt.Errorf("film: box %q has impossible size %d", kind, size)
		}
		if size > uint64(len(data)) {
			// A truncated read (the caller only reads the head of a
			// segment): hand over what is there, which is enough for a
			// moof that sits at the front.
			size = uint64(len(data))
		}
		if !fn(kind, data[header:size]) {
			return nil
		}
		data = data[size:]
	}
	return nil
}

// findBox descends path (e.g. "moov", "trak", "mdia", "mdhd") and returns the
// payload of the first match at each level.
func findBox(data []byte, path ...string) ([]byte, error) {
	for _, want := range path {
		var found []byte
		if err := childBoxes(data, func(kind string, payload []byte) bool {
			if kind == want {
				found = payload
				return false
			}
			return true
		}); err != nil {
			return nil, err
		}
		if found == nil {
			return nil, fmt.Errorf("%w: %s", errBoxNotFound, want)
		}
		data = found
	}
	return data, nil
}

// InitTimescale reads the media timescale (mdhd) of the first track of an
// init segment.
func InitTimescale(init []byte) (uint32, error) {
	mdhd, err := findBox(init, "moov", "trak", "mdia", "mdhd")
	if err != nil {
		return 0, err
	}
	if len(mdhd) < 4 {
		return 0, errors.New("film: short mdhd")
	}
	off := 12 // version+flags, creation, modification (32-bit)
	if mdhd[0] == 1 {
		off = 20 // 64-bit creation and modification
	}
	if len(mdhd) < off+4 {
		return 0, errors.New("film: short mdhd")
	}
	ts := binary.BigEndian.Uint32(mdhd[off : off+4])
	if ts == 0 {
		return 0, errors.New("film: mdhd timescale is zero")
	}
	return ts, nil
}

// FirstDecodeTime reads the baseMediaDecodeTime of the first fragment of a
// segment (moof/traf/tfdt), in the track's timescale.
func FirstDecodeTime(segment []byte) (uint64, error) {
	tfdt, err := findBox(segment, "moof", "traf", "tfdt")
	if err != nil {
		return 0, err
	}
	if len(tfdt) < 8 {
		return 0, errors.New("film: short tfdt")
	}
	if tfdt[0] == 1 {
		if len(tfdt) < 12 {
			return 0, errors.New("film: short tfdt")
		}
		return binary.BigEndian.Uint64(tfdt[4:12]), nil
	}
	return uint64(binary.BigEndian.Uint32(tfdt[4:8])), nil
}
