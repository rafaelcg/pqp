package session

import (
	"sync/atomic"
	"testing"
	"time"
)

// The replay playlists are the whole session on every write, so a live
// session writes them at most once per interval: first segment at once, the
// next one only after the interval has passed.
func TestVodPublishDue(t *testing.T) {
	var last atomic.Int64
	start := time.Unix(1_790_029_937, 0)
	if !vodPublishDue(&last, start, 30*time.Second) {
		t.Fatal("the first segment must write the playlist")
	}
	if vodPublishDue(&last, start.Add(4*time.Second), 30*time.Second) {
		t.Fatal("a segment inside the interval must not")
	}
	if !vodPublishDue(&last, start.Add(30*time.Second), 30*time.Second) {
		t.Fatal("the first segment past the interval must")
	}
	if vodPublishDue(&last, start.Add(34*time.Second), 30*time.Second) {
		t.Fatal("and the interval restarts from that write")
	}
}
