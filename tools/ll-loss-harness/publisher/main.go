// rampub publishes an H.264 Annex-B elementary stream file into a LiveKit
// room as a SCREEN_SHARE track -- the only source pqp-remux subscribes to
// (tools/pqp-remux/README.md, "Finds the presenter's screen-share video
// track"). Harness-only test tool: it exists so tools/ll-loss-harness can
// drive a real WebRTC publish through a lossy path without a human sitting
// in front of a browser sharing their screen.
//
// Deliberately NOT part of tools/pqp-remux/cmd -- that package ships the
// production remux binaries. This one is a fake presenter, kept next to the
// harness that is its only caller. See docs/plans/LL_HLS.md and
// tools/pqp-remux/README.md for what it is standing in for.
package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

// prodHostSuffix mirrors tools/watch-party-load's PROD_HOSTS guard
// (src/index.ts): this harness must never be able to reach the real
// pqp.gg SFU, no matter what LIVEKIT_URL an operator's environment
// happens to export. LIVEKIT_URL is set by tools/ll-loss-harness/run.sh
// from its own generated env file, but this binary checks it again at
// the point of use -- a second lock, same reasoning as that file's own
// comment on why it double-checks.
const prodHostSuffix = ".pqp.gg"

func assertNotProduction(url string) {
	lower := strings.ToLower(url)
	if strings.Contains(lower, "pqp.gg") {
		log.Fatalf("rampub: refusing LIVEKIT_URL=%q -- contains %q; this harness is local-only, see tools/ll-loss-harness/README.md", url, prodHostSuffix)
	}
}

func main() {
	url, key, secret := os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"), os.Getenv("LIVEKIT_API_SECRET")
	room, file, token := os.Getenv("ROOM"), os.Getenv("FILE"), os.Getenv("TOKEN")
	if url == "" || file == "" || (token == "" && (key == "" || secret == "" || room == "")) {
		log.Fatal("rampub: need LIVEKIT_URL, FILE and either TOKEN or LIVEKIT_API_KEY+LIVEKIT_API_SECRET+ROOM")
	}
	assertNotProduction(url)

	done := make(chan struct{})
	var rm *lksdk.Room
	var err error
	if token != "" {
		rm, err = lksdk.ConnectToRoomWithToken(url, token, &lksdk.RoomCallback{})
	} else {
		rm, err = lksdk.ConnectToRoom(url, lksdk.ConnectInfo{APIKey: key, APISecret: secret, RoomName: room, ParticipantIdentity: "ramp-presenter"}, &lksdk.RoomCallback{})
	}
	if err != nil {
		log.Fatal(err)
	}
	if room == "" {
		room = rm.Name()
	}
	pubOpts := &lksdk.TrackPublicationOptions{Name: "ramp", Source: livekit.TrackSource_SCREEN_SHARE, VideoWidth: 1280, VideoHeight: 720}
	if pace := os.Getenv("PACE"); pace != "" {
		// A paced publish: frames sent on a schedule of wall-clock gaps
		// rather than a fixed 33ms, to reproduce what a Chrome tab share
		// of a mostly static page sends. See pace.go.
		schedule, ok := schedules[pace]
		if !ok {
			log.Fatalf("rampub: unknown PACE=%q", pace)
		}
		seconds := 90
		if v := os.Getenv("PACE_SECONDS"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				seconds = n
			}
		}
		track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000})
		if err != nil {
			log.Fatal(err)
		}
		if _, err := rm.LocalParticipant.PublishTrack(track, pubOpts); err != nil {
			log.Fatal(err)
		}
		log.Printf("rampub: publishing %s as SCREEN_SHARE into %s, paced %q for %ds", file, room, pace, seconds)
		if err := publishPaced(track, file, schedule, time.Duration(seconds)*time.Second); err != nil {
			log.Fatal(err)
		}
		rm.Disconnect()
		return
	}
	if after := republishAfter(); after > 0 {
		// A MID-SHOW REPUBLISH: what a presenter's client does when it
		// resumes after an API deploy, or when they pick something else to
		// share. The file starts over on the new track, so the new source's
		// parameter sets differ from the old one's (the ramp begins at 360p
		// again), which is the init change the box has to carry inside the
		// same session. REPUBLISH=identity also leaves and rejoins under a
		// new identity: a reconnect that could not resume.
		republishMidShow(rm, url, key, secret, room, file, pubOpts, after)
		return
	}
	track, err := lksdk.NewLocalFileTrack(file, lksdk.ReaderTrackWithFrameDuration(33*time.Millisecond), lksdk.ReaderTrackWithOnWriteComplete(func() { close(done) }))
	if err != nil {
		log.Fatal(err)
	}
	if _, err := rm.LocalParticipant.PublishTrack(track, pubOpts); err != nil {
		log.Fatal(err)
	}
	log.Printf("rampub: publishing %s as SCREEN_SHARE into %s", file, room)
	<-done
	log.Printf("rampub: file complete, holding room open briefly before leaving")
	// Keep the room alive for a bit after the file ends so a slow viewer
	// (blocking reload, retries) still has something to reach; the
	// harness's own run.mjs window is what actually bounds the run.
	time.Sleep(5 * time.Second)
	rm.Disconnect()
}
