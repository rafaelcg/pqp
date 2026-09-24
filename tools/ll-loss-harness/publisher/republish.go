package main

import (
	"log"
	"os"
	"strconv"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
)

// republishAfter is REPUBLISH_AFTER, in seconds (0 or unset: publish once,
// the ordinary run).
func republishAfter() time.Duration {
	v := os.Getenv("REPUBLISH_AFTER")
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

// republishMidShow publishes the file, and `after` into it replaces the
// screen-share track with a new one playing the file from the start.
//
// REPUBLISH=track (the default): the same participant unpublishes and
// publishes again, the shape a web client's resume after a deploy has.
// REPUBLISH=identity: the participant leaves, and a new one joins as
// REPUBLISH_IDENTITY (default "ramp-presenter-2") and publishes: a reconnect
// that could not resume, which pqp-api answers with POST
// /sessions/:id/rebind (run.sh plays that part).
func republishMidShow(rm *lksdk.Room, url, key, secret, room, file string, opts *lksdk.TrackPublicationOptions, after time.Duration) {
	first, err := lksdk.NewLocalFileTrack(file, lksdk.ReaderTrackWithFrameDuration(33*time.Millisecond))
	if err != nil {
		log.Fatal(err)
	}
	pub, err := rm.LocalParticipant.PublishTrack(first, opts)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("rampub: publishing %s as SCREEN_SHARE into %s; republishing in %s", file, room, after)
	time.Sleep(after)

	mode := os.Getenv("REPUBLISH")
	target := rm
	if mode == "identity" {
		identity := os.Getenv("REPUBLISH_IDENTITY")
		if identity == "" {
			identity = "ramp-presenter-2"
		}
		rm.Disconnect()
		log.Printf("rampub: left the room; rejoining as %q (a reconnect that could not resume)", identity)
		// The gap a real reconnect has: the socket drops, the client comes
		// back a moment later.
		time.Sleep(1500 * time.Millisecond)
		next, err := lksdk.ConnectToRoom(url, lksdk.ConnectInfo{APIKey: key, APISecret: secret, RoomName: room, ParticipantIdentity: identity}, &lksdk.RoomCallback{})
		if err != nil {
			log.Fatal(err)
		}
		target = next
	} else {
		if err := rm.LocalParticipant.UnpublishTrack(pub.SID()); err != nil {
			log.Printf("rampub: unpublish: %v", err)
		}
		log.Printf("rampub: unpublished the screen track %s", pub.SID())
		time.Sleep(700 * time.Millisecond)
	}

	done := make(chan struct{})
	second, err := lksdk.NewLocalFileTrack(file, lksdk.ReaderTrackWithFrameDuration(33*time.Millisecond), lksdk.ReaderTrackWithOnWriteComplete(func() { close(done) }))
	if err != nil {
		log.Fatal(err)
	}
	pub2, err := target.LocalParticipant.PublishTrack(second, opts)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("rampub: republished the screen as a new track %s", pub2.SID())
	<-done
	log.Printf("rampub: file complete, holding room open briefly before leaving")
	time.Sleep(5 * time.Second)
	target.Disconnect()
}
