package aacenc

import (
	"bufio"
	"fmt"
	"io"
)

// readOneADTSFrame reads and strips one ADTS frame header (ISO/IEC
// 13818-7 Annex B) from br, returning the raw AAC-LC access unit
// underneath. It resyncs on stray bytes (any byte that isn't a valid
// 0xFFF syncword start is skipped one at a time) rather than failing
// outright: ffmpeg's own ADTS muxer never emits garbage between frames in
// practice, but a subprocess pipe is still an external boundary, and
// resyncing costs nothing when there is nothing to resync from.
//
// Only a single raw_data_block per ADTS frame is supported (the
// overwhelmingly common case, and what ffmpeg's encoder emits for a
// stereo/mono stream): a frame declaring more than one is reported as an
// error rather than silently mis-parsed.
func readOneADTSFrame(br *bufio.Reader) (Frame, error) {
	header := make([]byte, 7)
	for {
		b, err := br.ReadByte()
		if err != nil {
			return Frame{}, err
		}
		if b != 0xFF {
			continue
		}
		b2, err := br.Peek(1)
		if err != nil {
			return Frame{}, err
		}
		if b2[0]&0xF0 != 0xF0 {
			continue // not actually a syncword; keep scanning
		}
		header[0] = b
		if _, err := io.ReadFull(br, header[1:7]); err != nil {
			return Frame{}, err
		}
		break
	}

	protectionAbsent := header[1]&0x01 != 0
	frameLength := (uint32(header[3]&0x03) << 11) | (uint32(header[4]) << 3) | (uint32(header[5]) >> 5)
	numBlocks := header[6] & 0x03 // raw_data_blocks_in_frame - 1

	headerLen := uint32(7)
	if !protectionAbsent {
		// CRC present: 2 more bytes before the payload (ISO/IEC 13818-7
		// Annex B, adts_error_check()).
		crc := make([]byte, 2)
		if _, err := io.ReadFull(br, crc); err != nil {
			return Frame{}, err
		}
		headerLen = 9
	}

	if numBlocks != 0 {
		return Frame{}, fmt.Errorf("aacenc: ADTS frame carries %d raw_data_blocks, only 1 is supported", numBlocks+1)
	}
	if frameLength < headerLen {
		return Frame{}, fmt.Errorf("aacenc: ADTS frame_length %d shorter than its own %d-byte header", frameLength, headerLen)
	}

	payload := make([]byte, frameLength-headerLen)
	if _, err := io.ReadFull(br, payload); err != nil {
		return Frame{}, err
	}
	return Frame{Data: payload}, nil
}
