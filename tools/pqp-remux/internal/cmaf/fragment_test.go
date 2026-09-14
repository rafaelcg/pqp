package cmaf

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func sample(idr bool, duration uint32, data []byte) Sample {
	return Sample{Duration: duration, IsSync: idr, Data: data}
}

func TestBuildFragment_StructureAndDataOffset(t *testing.T) {
	samples := []Sample{
		sample(true, 3000, bytes.Repeat([]byte{0xAA}, 40)),
		sample(false, 3000, bytes.Repeat([]byte{0xBB}, 25)),
		sample(false, 3000, bytes.Repeat([]byte{0xCC}, 10)),
	}
	frag := BuildFragment(FragmentParams{
		SequenceNumber:      7,
		BaseMediaDecodeTime: 123456,
		Samples:             samples,
	})

	top, err := parseBoxes(frag)
	if err != nil {
		t.Fatalf("parseBoxes: %v", err)
	}
	if len(top) != 2 || top[0].Type != "moof" || top[1].Type != "mdat" {
		t.Fatalf("expected [moof, mdat], got %v", boxTypes(top))
	}

	moofChildren, err := parseBoxes(top[0].Body)
	if err != nil {
		t.Fatalf("parseBoxes(moof): %v", err)
	}
	mfhd, ok := findBox(moofChildren, "mfhd")
	if !ok {
		t.Fatal("moof has no mfhd")
	}
	_, _, mfhdRest := fullBoxFields(mfhd.Body)
	if seq := binary.BigEndian.Uint32(mfhdRest); seq != 7 {
		t.Fatalf("mfhd sequence_number = %d, want 7", seq)
	}

	traf, ok := findBox(moofChildren, "traf")
	if !ok {
		t.Fatal("moof has no traf")
	}
	trafChildren, err := parseBoxes(traf.Body)
	if err != nil {
		t.Fatalf("parseBoxes(traf): %v", err)
	}

	tfhd, ok := findBox(trafChildren, "tfhd")
	if !ok {
		t.Fatal("traf has no tfhd")
	}
	_, tfhdFlags, tfhdRest := fullBoxFields(tfhd.Body)
	if tfhdFlags != 0x020000 {
		t.Fatalf("tfhd flags = 0x%06X, want 0x020000 (default-base-is-moof)", tfhdFlags)
	}
	if trackID := binary.BigEndian.Uint32(tfhdRest); trackID != TrackID {
		t.Fatalf("tfhd track_ID = %d, want %d", trackID, TrackID)
	}

	tfdt, ok := findBox(trafChildren, "tfdt")
	if !ok {
		t.Fatal("traf has no tfdt")
	}
	version, _, tfdtRest := fullBoxFields(tfdt.Body)
	if version != 1 {
		t.Fatalf("tfdt version = %d, want 1 (64-bit baseMediaDecodeTime)", version)
	}
	if bmdt := binary.BigEndian.Uint64(tfdtRest); bmdt != 123456 {
		t.Fatalf("tfdt baseMediaDecodeTime = %d, want 123456", bmdt)
	}

	trun, ok := findBox(trafChildren, "trun")
	if !ok {
		t.Fatal("traf has no trun")
	}
	_, trunFlags, trunRest := fullBoxFields(trun.Body)
	const wantFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400
	if trunFlags != wantFlags {
		t.Fatalf("trun flags = 0x%06X, want 0x%06X", trunFlags, wantFlags)
	}
	sampleCount := binary.BigEndian.Uint32(trunRest[0:4])
	dataOffset := binary.BigEndian.Uint32(trunRest[4:8])
	if int(sampleCount) != len(samples) {
		t.Fatalf("trun sample_count = %d, want %d", sampleCount, len(samples))
	}
	// data_offset is relative to the start of moof (default-base-is-moof);
	// mdat's payload must begin exactly there.
	wantOffset := len(top[0].Body) + 8 /* moof's own box header */ + 8 /* mdat header */
	if int(dataOffset) != wantOffset {
		t.Fatalf("trun data_offset = %d, want %d", dataOffset, wantOffset)
	}

	entries := trunRest[8:]
	for i, s := range samples {
		e := entries[i*12 : i*12+12]
		gotDuration := binary.BigEndian.Uint32(e[0:4])
		gotSize := binary.BigEndian.Uint32(e[4:8])
		gotFlags := binary.BigEndian.Uint32(e[8:12])
		if gotDuration != s.Duration {
			t.Fatalf("sample %d duration = %d, want %d", i, gotDuration, s.Duration)
		}
		if int(gotSize) != len(s.Data) {
			t.Fatalf("sample %d size = %d, want %d", i, gotSize, len(s.Data))
		}
		wantFlags := sampleFlagsNonSync
		if s.IsSync {
			wantFlags = sampleFlagsSync
		}
		if gotFlags != wantFlags {
			t.Fatalf("sample %d flags = 0x%08X, want 0x%08X", i, gotFlags, wantFlags)
		}
	}

	// mdat must be exactly the samples' bytes, concatenated in order, byte
	// for byte: this is the passthrough guarantee the plan's acceptance
	// test cares about ("extracted NAL units match the published stream
	// byte for byte").
	var want []byte
	for _, s := range samples {
		want = append(want, s.Data...)
	}
	if !bytes.Equal(top[1].Body, want) {
		t.Fatal("mdat payload does not match the concatenated sample data byte for byte")
	}
}

func TestBuildFragment_PanicsOnEmptySamples(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic on zero samples")
		}
	}()
	BuildFragment(FragmentParams{SequenceNumber: 1, Samples: nil})
}

func TestBuildFragment_SequenceNumbersAndTfdtMonotonic(t *testing.T) {
	var prevSeq uint32
	var prevBMDT uint64
	for i, bmdt := range []uint64{0, 45000, 90000, 500000} {
		frag := BuildFragment(FragmentParams{
			SequenceNumber:      uint32(i + 1),
			BaseMediaDecodeTime: bmdt,
			Samples:             []Sample{sample(i == 0, 45000, []byte{0x01, 0x02, 0x03})},
		})
		top, err := parseBoxes(frag)
		if err != nil {
			t.Fatalf("fragment %d: parseBoxes: %v", i, err)
		}
		moofChildren, _ := parseBoxes(top[0].Body)
		mfhd, _ := findBox(moofChildren, "mfhd")
		_, _, mfhdRest := fullBoxFields(mfhd.Body)
		seq := binary.BigEndian.Uint32(mfhdRest)

		traf, _ := findBox(moofChildren, "traf")
		trafChildren, _ := parseBoxes(traf.Body)
		tfdt, _ := findBox(trafChildren, "tfdt")
		_, _, tfdtRest := fullBoxFields(tfdt.Body)
		gotBMDT := binary.BigEndian.Uint64(tfdtRest)

		if i > 0 {
			if seq != prevSeq+1 {
				t.Fatalf("fragment %d: sequence_number %d does not follow %d by exactly 1", i, seq, prevSeq)
			}
			if gotBMDT < prevBMDT {
				t.Fatalf("fragment %d: tfdt base decode time %d is less than the previous fragment's %d", i, gotBMDT, prevBMDT)
			}
		}
		prevSeq = seq
		prevBMDT = gotBMDT
	}
}

func boxTypes(boxes []parsedBox) []string {
	out := make([]string, len(boxes))
	for i, b := range boxes {
		out[i] = b.Type
	}
	return out
}
