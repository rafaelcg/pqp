package r2

import (
	"fmt"
	"math"
	"strings"
	"sync"
)

// VodIndex is the session's OWN record of every segment it has ever
// uploaded, and the renderer of the three playlists that turn those objects
// back into something a player can open after the party is over.
//
// WHY THIS EXISTS AT ALL. The LL path's live playlist is built by the edge
// Worker from state.json and never written down: it lives in this process's
// memory, describes only the segments still in the ring, and disappears with
// the session. So an LL broadcast left a bucket full of `video-seg-N.m4s`
// with nothing naming them, in what order, or against which init segment --
// the conventional ladder's replay works only because LiveKit writes an
// ever-growing `-index.m3u8` beside its segments, and nothing was doing that
// here.
//
// WHY IT IS NOT THE RING. The ring is a fixed-size DVR window and evicts its
// oldest segment on every rollover; a VOD playlist is the WHOLE session. What
// is kept here per closed segment is a name, a duration, a byte count and the
// init it was built against -- a few dozen bytes, so a four-hour show costs
// well under a megabyte, against the hundreds of megabytes keeping the bytes
// themselves would cost.
//
// WHY IT OUTLIVES A PIPELINE. internal/control's watchdog may close a
// session's pipeline and build a replacement, continuing the segment
// numbering (managed_session.go's restart). The replacement is a new
// internal/session.Session with a new ring and a new Writer, so an index
// owned by either of those would silently drop everything before the restart
// and publish a playlist that starts in the middle of the show. One index per
// SESSION, handed to whichever pipeline is current.
//
// Safe for concurrent use: the video track's segments are added on the packet
// goroutine and the audio track's on the encoder-reader goroutine.
type VodIndex struct {
	mu sync.Mutex

	video vodTrack
	audio vodTrack

	// codec/width/height describe the CURRENT video init segment, for the
	// multivariant playlist's CODECS and RESOLUTION attributes. A
	// parameter-set change overwrites them: a single-variant master can only
	// state one, and the newest is the one a player joining the replay will
	// be decoding by the time it matters. Empty codec means no init has been
	// published yet, which is also when MasterPlaylist has nothing to say.
	codec  string
	width  int
	height int

	// ended is set by Finish and cleared by the next segment that arrives.
	// The clear is what makes a watchdog restart self-healing: the old
	// pipeline's teardown writes ENDLIST, the replacement's first segment
	// takes it away again, and last-write-wins on the object does the rest.
	ended bool
}

// vodTrack is one rendition's accumulated segment list.
type vodTrack struct {
	entries []VodSegment
	// at maps an object name to its position in entries, so a segment
	// uploaded twice (Finish running after a flush already sealed the same
	// index, say) replaces its own line instead of appending a duplicate the
	// player would stall on.
	at map[string]int
	// peakBitsPerSecond is the worst segment this track has produced, which
	// is what BANDWIDTH is defined as (RFC 8216bis: the peak segment bit
	// rate, not the average).
	peakBitsPerSecond int
}

// VodSegment is one closed segment as the playlist needs it.
type VodSegment struct {
	// Name is the object name relative to the session prefix, exactly as it
	// was PUT (`video-seg-12.m4s`).
	Name string
	// Seconds is the segment's true duration. Taken from the durations the
	// fragmenter already computed, never guessed from the target.
	Seconds float64
	// InitURI is the object name of the CMAF init segment this segment's
	// samples were built against (`video-init.mp4`, `video-init-7.mp4`), so
	// a mid-session parameter-set change leaves older segments pointing at
	// the init that still describes them.
	InitURI string
	// Discontinuity is true when this segment is the first to use a new
	// InitURI, or the first a replacement pipeline produced after a
	// watchdog restart. It renders as #EXT-X-DISCONTINUITY (ahead of the
	// fresh #EXT-X-MAP when there is one), which is what lets a player
	// rebuild its decoder rather than feeding 720p samples to a 360p
	// configuration, and reset its clock when the timestamps start over.
	Discontinuity bool
}

// The three objects a session writes beside its media, and the one content
// type all of them take. Names are relative to the session's object prefix.
const (
	VodVideoPlaylistName  = "video.m3u8"
	VodAudioPlaylistName  = "audio.m3u8"
	VodMasterPlaylistName = "master.m3u8"
	PlaylistContentType   = "application/vnd.apple.mpegurl"
)

// AacLcCodec is the only audio profile this box produces (internal/aacenc is
// LC-only), so the audio half of CODECS is a constant rather than a read of
// audio-init.mp4's esds box -- the same call tools/hls-edge's own
// ll-init-codecs.js makes, for the same reason.
const AacLcCodec = "mp4a.40.2"

// NewVodIndex returns an empty index.
func NewVodIndex() *VodIndex {
	return &VodIndex{
		video: vodTrack{at: make(map[string]int)},
		audio: vodTrack{at: make(map[string]int)},
	}
}

// SetVideoInit records the codec string and picture size of the init segment
// just published, for the multivariant playlist. Called on every init,
// including the replacements a parameter-set change produces.
func (v *VodIndex) SetVideoInit(codec string, width, height int) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.codec = codec
	v.width = width
	v.height = height
}

// AddVideoSegment records one closed video segment. Adding anything reopens
// the playlist (see VodIndex.ended).
func (v *VodIndex) AddVideoSegment(seg VodSegment, bytes int) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.ended = false
	v.video.add(seg, bytes)
}

// AddAudioSegment is AddVideoSegment's audio counterpart.
func (v *VodIndex) AddAudioSegment(seg VodSegment, bytes int) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.ended = false
	v.audio.add(seg, bytes)
}

// Finish marks the session over: the next render carries
// #EXT-X-PLAYLIST-TYPE:VOD and #EXT-X-ENDLIST instead of EVENT and an open
// tail.
func (v *VodIndex) Finish() {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.ended = true
}

// HasVideo reports whether any video segment has been recorded, which is the
// only condition under which a master playlist means anything.
func (v *VodIndex) HasVideo() bool {
	if v == nil {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.video.entries) > 0
}

func (t *vodTrack) add(seg VodSegment, bytes int) {
	if seg.Seconds > 0 && bytes > 0 {
		if bps := int(float64(bytes) * 8 / seg.Seconds); bps > t.peakBitsPerSecond {
			t.peakBitsPerSecond = bps
		}
	}
	if i, ok := t.at[seg.Name]; ok {
		t.entries[i] = seg
		return
	}
	t.at[seg.Name] = len(t.entries)
	t.entries = append(t.entries, seg)
}

// VideoPlaylist and AudioPlaylist render one track's media playlist, or
// ("", false) when that track has produced nothing yet.
func (v *VodIndex) VideoPlaylist() (string, bool) {
	if v == nil {
		return "", false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return renderMediaPlaylist(&v.video, v.ended)
}

func (v *VodIndex) AudioPlaylist() (string, bool) {
	if v == nil {
		return "", false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return renderMediaPlaylist(&v.audio, v.ended)
}

// renderMediaPlaylist writes a standard, non-low-latency HLS media playlist
// over the whole accumulated segment list. Deliberately plain: no
// EXT-X-PART, no preload hint, no blocking reload. Those tags exist to shave
// a live stream's latency and mean nothing to a recording; a player opening
// this two days later wants the boring playlist every decoder has read since
// 2010.
//
// Caller holds v.mu.
func renderMediaPlaylist(t *vodTrack, ended bool) (string, bool) {
	if len(t.entries) == 0 {
		return "", false
	}

	// EXT-X-TARGETDURATION is an integer ceiling and must not be smaller
	// than any EXTINF, so it is computed over the WHOLE list rather than
	// carried from the ring's own running maximum (which only ever saw the
	// window).
	target := 1
	for _, seg := range t.entries {
		if secs := int(math.Ceil(seg.Seconds)); secs > target {
			target = secs
		}
	}

	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:7\n")
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", target)
	if ended {
		b.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	} else {
		// EVENT, not VOD, while the show is still running: it promises a
		// player that segments are only ever APPENDED, which is exactly what
		// this index does, and lets somebody open the recording of a party
		// that has not finished yet.
		b.WriteString("#EXT-X-PLAYLIST-TYPE:EVENT\n")
	}
	// Always 0: this playlist is the whole session from its first segment,
	// so nothing has ever rolled off the front of it.
	b.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	b.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")

	currentInit := ""
	for i, seg := range t.entries {
		initChanged := seg.InitURI != currentInit
		// The DISCONTINUITY goes BEFORE the MAP, and never ahead of the
		// first segment. Any init change after the first earns one, flagged
		// or not: a new init after a watchdog restart is not a parameter-set
		// change as far as the ring knows, but its timestamps restart and a
		// player needs telling. A flagged segment on an unchanged init (the
		// audio track across a restart, which keeps audio-init.mp4) earns
		// one for the same reason.
		if i > 0 && (initChanged || seg.Discontinuity) {
			b.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		if initChanged {
			fmt.Fprintf(&b, "#EXT-X-MAP:URI=%q\n", seg.InitURI)
			currentInit = seg.InitURI
		}
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n", seg.Seconds)
		b.WriteString(seg.Name)
		b.WriteString("\n")
	}
	if ended {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	return b.String(), true
}

// MasterPlaylist renders the one-variant multivariant playlist that pairs the
// video rendition with the audio one, or ("", false) before there is a video
// segment and an init to describe it.
func (v *VodIndex) MasterPlaylist() (string, bool) {
	if v == nil {
		return "", false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.video.entries) == 0 || v.codec == "" {
		return "", false
	}

	codecs := v.codec
	haveAudio := len(v.audio.entries) > 0
	if haveAudio {
		codecs += "," + AacLcCodec
	}
	bandwidth := v.video.peakBitsPerSecond + v.audio.peakBitsPerSecond
	if bandwidth <= 0 {
		// Never emit BANDWIDTH=0: it is a required attribute and a player is
		// entitled to use it for its very first pick. One megabit is an
		// honest placeholder for a session whose segments all came back
		// zero-length, which in practice means a session with no media.
		bandwidth = 1_000_000
	}

	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:7\n")
	b.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	if haveAudio {
		fmt.Fprintf(&b,
			"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"audio\",DEFAULT=YES,AUTOSELECT=YES,URI=%q\n",
			VodAudioPlaylistName)
	}
	attrs := []string{fmt.Sprintf("BANDWIDTH=%d", bandwidth)}
	if v.width > 0 && v.height > 0 {
		attrs = append(attrs, fmt.Sprintf("RESOLUTION=%dx%d", v.width, v.height))
	}
	attrs = append(attrs, fmt.Sprintf("CODECS=%q", codecs))
	if haveAudio {
		attrs = append(attrs, `AUDIO="audio"`)
	}
	fmt.Fprintf(&b, "#EXT-X-STREAM-INF:%s\n", strings.Join(attrs, ","))
	b.WriteString(VodVideoPlaylistName)
	b.WriteString("\n")
	return b.String(), true
}
