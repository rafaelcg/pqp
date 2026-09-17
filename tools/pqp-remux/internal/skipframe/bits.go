package skipframe

import "fmt"

// bitReader reads an RBSP the way §7.2 describes: most significant bit
// first, Exp-Golomb where the syntax says ue(v)/se(v). It is a reader for
// the few dozen bits at the front of a slice header, not for slice data,
// and it records its own position so a caller can rewrite a fixed-width
// field it has just read.
//
// internal/nal has a reader of the same shape, unexported and parse-only.
// This one is here because this package needs a reader and a WRITER over
// the same bits, and splitting the pair across two packages would put the
// two halves of one format out of each other's sight.
type bitReader struct {
	data []byte
	pos  int
	err  error
}

func newBitReader(b []byte) *bitReader { return &bitReader{data: b} }

func (r *bitReader) bit() uint32 {
	if r.err != nil {
		return 0
	}
	i := r.pos >> 3
	if i >= len(r.data) {
		r.err = errShortRBSP
		return 0
	}
	v := (r.data[i] >> (7 - uint(r.pos&7))) & 1
	r.pos++
	return uint32(v)
}

func (r *bitReader) bits(n int) uint32 {
	var v uint32
	for i := 0; i < n; i++ {
		v = (v << 1) | r.bit()
	}
	return v
}

func (r *bitReader) ue() uint32 {
	zeros := 0
	for r.bit() == 0 {
		zeros++
		if r.err != nil || zeros > 32 {
			if r.err == nil {
				r.err = errBadExpGolomb
			}
			return 0
		}
	}
	if zeros == 0 {
		return 0
	}
	return (1 << uint(zeros)) - 1 + r.bits(zeros)
}

// bitWriter is the mirror image: it builds an RBSP most significant bit
// first and pads it with rbsp_trailing_bits at the end.
type bitWriter struct {
	out   []byte
	cur   byte
	nbits uint
}

func (w *bitWriter) bit(b uint32) {
	w.cur = (w.cur << 1) | byte(b&1)
	w.nbits++
	if w.nbits == 8 {
		w.out = append(w.out, w.cur)
		w.cur = 0
		w.nbits = 0
	}
}

func (w *bitWriter) bits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.bit((v >> uint(i)) & 1)
	}
}

// ue writes an unsigned Exp-Golomb value (§9.1): the bit length of v+1
// minus one zeros, then v+1 itself.
func (w *bitWriter) ue(v uint32) {
	x := uint64(v) + 1
	n := 0
	for t := x; t > 1; t >>= 1 {
		n++
	}
	for i := 0; i < n; i++ {
		w.bit(0)
	}
	for i := n; i >= 0; i-- {
		w.bit(uint32((x >> uint(i)) & 1))
	}
}

// se writes a signed Exp-Golomb value (§9.1.1).
func (w *bitWriter) se(v int32) {
	if v <= 0 {
		w.ue(uint32(-2 * v))
		return
	}
	w.ue(uint32(2*v - 1))
}

// trailing appends rbsp_trailing_bits (§7.3.2.11): a single one bit, then
// zeros to the next byte boundary, and returns the finished RBSP.
func (w *bitWriter) trailing() []byte {
	w.bit(1)
	for w.nbits != 0 {
		w.bit(0)
	}
	return w.out
}

// writeBitsAt overwrites n bits at bit offset pos in an existing RBSP,
// most significant bit first. Used for frame_num, whose width is fixed by
// the SPS, so the buffer never changes length.
func writeBitsAt(buf []byte, pos int, v uint32, n int) error {
	if n <= 0 || n > 32 {
		return fmt.Errorf("skipframe: refusing to write a %d-bit field", n)
	}
	if pos < 0 || pos+n > len(buf)*8 {
		return fmt.Errorf("skipframe: field at bit %d..%d runs past the %d-bit payload", pos, pos+n, len(buf)*8)
	}
	for i := 0; i < n; i++ {
		bit := (v >> uint(n-1-i)) & 1
		idx := (pos + i) >> 3
		mask := byte(1) << (7 - uint((pos+i)&7))
		if bit == 1 {
			buf[idx] |= mask
		} else {
			buf[idx] &^= mask
		}
	}
	return nil
}

type bitsError string

func (e bitsError) Error() string { return string(e) }

const (
	errShortRBSP    = bitsError("skipframe: rbsp ended before the slice header did")
	errBadExpGolomb = bitsError("skipframe: exp-golomb code longer than 32 leading zeros")
)
