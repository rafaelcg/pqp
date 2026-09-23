package film

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Segment is one media segment as the VOD playlist names it.
type Segment struct {
	// Name is relative to the session prefix, exactly as the box PUT it.
	Name    string
	Seconds float64
}

// Group is a run of segments that decode against one init segment with no
// discontinuity between them: init + segments is one valid fragmented MP4.
type Group struct {
	Init     string
	Segments []Segment
}

var mapURI = regexp.MustCompile(`URI="([^"]+)"`)

// ParsePlaylist splits a VOD media playlist (internal/r2.VodIndex's format)
// into groups. A new group starts at every #EXT-X-MAP that names a different
// init and at every #EXT-X-DISCONTINUITY, because the box writes one of
// those exactly where the timestamps or the decoder configuration change.
// A segment before any #EXT-X-MAP is an error: CMAF without an init is not
// decodable, and guessing one would produce a corrupt film.
func ParsePlaylist(body string) ([]Group, error) {
	var groups []Group
	var current *Group
	currentInit := ""
	pendingBreak := false
	pendingSeconds := -1.0
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "":
			continue
		case line == "#EXT-X-DISCONTINUITY":
			pendingBreak = true
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			m := mapURI.FindStringSubmatch(line)
			if m == nil {
				return nil, fmt.Errorf("film: EXT-X-MAP without a URI: %q", line)
			}
			if m[1] != currentInit {
				currentInit = m[1]
				pendingBreak = true
			}
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimPrefix(line, "#EXTINF:")
			if i := strings.IndexByte(value, ','); i >= 0 {
				value = value[:i]
			}
			secs, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return nil, fmt.Errorf("film: bad EXTINF %q: %w", line, err)
			}
			pendingSeconds = secs
		case strings.HasPrefix(line, "#"):
			continue
		default:
			if currentInit == "" {
				return nil, fmt.Errorf("film: segment %q comes before any EXT-X-MAP", line)
			}
			if current == nil || pendingBreak {
				groups = append(groups, Group{Init: currentInit})
				current = &groups[len(groups)-1]
				pendingBreak = false
			}
			secs := pendingSeconds
			if secs < 0 {
				secs = 0
			}
			current.Segments = append(current.Segments, Segment{Name: line, Seconds: secs})
			pendingSeconds = -1
		}
	}
	return groups, nil
}
