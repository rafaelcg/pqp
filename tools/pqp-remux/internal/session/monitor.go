package session

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
)

// THE 2026-09-15 STALL, AND WHY THIS FILE EXISTS.
//
// A production watch party on a Chrome TAB share stalled producing parts
// after ~40s, was restarted by the control plane's PART_STUCK_MS watchdog,
// ran for another four minutes, stalled again and demoted the party off the
// low-latency rung. The whole five-minute service log held fourteen
// depacketize warnings and nothing else, so four different explanations fit
// it equally well:
//
//	(a) no RTP frames were arriving at all -- a Chrome tab share of static
//	    content sends NO new frames while nothing on the page repaints;
//	(b) frames were arriving and the depacketizer was waiting forever for a
//	    keyframe after loss (the presenter's uplink measured 27% loss on
//	    1200-byte pings during the test);
//	(c) parts were being produced and the watchdog was measuring the wrong
//	    thing;
//	(d) the writer or the S3 path was blocking.
//
// Two things come out of that. First, every one of those four now leaves a
// distinct trail: the periodic stats line below carries packets, frames,
// keyframes, PLIs, parts, segments, depacketizer drops and upload latency
// per window, so the next stall is read off one line. Second, (a) is not a
// stall at all and must never have been treated as one -- see idleTick,
// which publishes the held access unit so the playlist and a viewer's
// buffer cover the gap, and internal/control's watchdog, which no longer
// restarts or demotes a session whose source has simply gone quiet.

// statsInterval is how often RunMonitor writes the periodic line. Every
// few seconds per session: frequent enough that a 3s stall window has
// context on both sides of it, cheap enough to leave on always (one
// formatted line per session per interval, no allocation per packet).
const statsInterval = 5 * time.Second

// monitorTick is how often RunMonitor wakes to consider a keep-alive
// flush. Finer than a part target so the held frame is published close to
// the moment the part boundary passes rather than up to a whole tick late.
const monitorTick = 100 * time.Millisecond

// videoIdleAfter returns how long with no completed access unit counts as
// "the source has gone quiet" -- both for this session's own logging and,
// since the 2026-09-15 drift fix, as the keep-alive deadline: the point
// past which idleTick stops waiting for a real frame and publishes the
// held one. Two part targets, floored at a second: shorter than that and
// an ordinary low-frame-rate screen share (a slide, a paused video) would
// flap in and out of "idle" on every frame.
//
// ONE THRESHOLD, TWO USES, ON PURPOSE. Waiting a whole allowance before
// publishing early is what keeps an ordinary quiet source exact. A Chrome
// tab share of a nearly static page sends about 1.4 frames a second, so
// its frame gaps sit between the 500ms part target and this allowance:
// under the old rule (publish at the part target) every single one of
// those gaps was published early with a guessed duration, and the
// keep-alive became the ONLY way parts were ever produced -- production's
// 15:23 UTC watchdog detail read `parts=74 keepalive=74`. Now those gaps
// close on the frame that really ends them and carry its true duration,
// so their parts run longer than PART-TARGET and the timeline is exact;
// only a genuine freeze, longer than this allowance, reaches the
// keep-alive at all.
//
// NOT THE SAME QUESTION AS internal/control's `sourceIdle`, which gates
// the restart/demote ladder and asks for no frames AND NO PACKETS for
// PART_STUCK_MS (3s). This one is "should we stop waiting for a frame";
// that one is "is the ladder allowed to run". Both are named idle and
// they are deliberately different lengths.
func (s *Session) videoIdleAfter() time.Duration {
	d := 2 * ticksToDuration(int64(s.partTicks))
	if d < time.Second {
		d = time.Second
	}
	return d
}

func ticksToDuration(ticks int64) time.Duration {
	return time.Duration(ticks) * time.Second / time.Duration(h264.ClockRate)
}

// durationToTicks converts wall-clock time into 90 kHz media ticks,
// multiplying only AFTER reducing to milliseconds so a long duration
// cannot overflow int64 on the way (d*90000 wraps somewhere past a day).
// The millisecond truncation costs at most 90 ticks, a thousandth of a
// second of a held frame's duration.
func durationToTicks(d time.Duration) int64 {
	return d.Milliseconds() * h264.ClockRate / 1000
}

// StartMonitor starts RunMonitor on its own goroutine and returns a stop
// function that cancels it AND WAITS for it to return.
//
// The wait is the point. The monitor is the only thing besides the
// subscriber's RTP goroutine that touches the fragmenter, and a caller
// tearing a pipeline down reads that fragmenter's final segment index and
// part sequence immediately afterwards (internal/control's restart, to
// hand them to the replacement). videoMu already makes the two safe
// against each other, and Close's own fence makes a post-Close tick inert
// -- but a teardown that can simply say "the monitor is finished" before
// it touches anything is a much smaller thing to have to reason about
// than one that relies on both (Farol review, PR #626). Call stop BEFORE
// disconnecting the subscriber.
//
// Idempotent: calling stop more than once is safe.
//
// Start it once, after New and after EnableAudio/EnableR2 if those are
// wanted, so the first line already reports them.
func (s *Session) StartMonitor(ctx context.Context, label string) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.RunMonitor(ctx, label)
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

// RunMonitor is this session's own always-on observability and keep-alive
// loop: it publishes the held video access unit when the source goes quiet
// (idleTick) and writes one stats line per statsInterval, labelled with
// whatever the caller calls this session (a session id under pqp-remuxd, a
// room name under the single-session binary).
//
// It returns when ctx is done. Prefer StartMonitor, which gives you a stop
// function that also waits for this to have returned.
func (s *Session) RunMonitor(ctx context.Context, label string) {
	ticker := time.NewTicker(monitorTick)
	defer ticker.Stop()

	prev := s.Stats()
	prevAt := time.Now()
	nextStats := prevAt.Add(statsInterval)

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.idleTick(now)
			if now.Before(nextStats) {
				continue
			}
			cur := s.Stats()
			log.Print(formatStatsLine(label, prev, cur, now.Sub(prevAt)))
			prev, prevAt = cur, now
			nextStats = now.Add(statsInterval)
		}
	}
}

// idleTick is the static-source fix. When no access unit has completed for
// a whole idle allowance (videoIdleAfter), the fragmenter is holding one
// with nowhere to put it -- every part boundary in internal/pipeline is
// decided by the NEXT access unit's arrival, and a Chrome tab share of a
// page that is not repainting never sends one. IdleFlush publishes the
// held one, with the duration it really had, so the playlist keeps
// advancing and a viewer's video buffer covers the freeze instead of
// ending at the start of it.
//
// It returns true when it published a part. A source that is sending at
// any ordinary rate, fast or slow, never reaches the flush at all (the
// held AU is younger than the allowance on every tick), so this costs one
// atomic load and a comparison per tick in the ordinary case -- and its
// parts close on real frames with real durations, which is why the media
// timeline tracks the wall clock at 1.4 frames/s exactly as it does at
// 30.
//
// THE LIMIT, STATED: one part per idle episode (see
// pipeline.Fragmenter.IdleFlush). Past that the video timeline is HELD at
// the last frame while the audio track -- paced off the wall clock, so it
// never goes idle -- keeps producing parts, which is the "emit audio-only
// parts and hold the video timeline" half of the two options. Publishing
// more video than that would mean sending a coded frame the publisher
// never sent twice, which is safe only for an IDR and is not something
// this pipeline does.
func (s *Session) idleTick(now time.Time) bool {
	lastFrame := s.lastVideoFrameAtNs.Load()
	if lastFrame == 0 {
		return false // nothing has ever arrived; there is no timeline to hold
	}
	held := now.Sub(time.Unix(0, lastFrame))
	if held <= 0 {
		return false
	}

	if held >= s.videoIdleAfter() && s.videoIdle.CompareAndSwap(false, true) {
		log.Printf("pqp-remux: video source idle: no frame for %s (packets=%d frames=%d lastIdrAgoMs=%d) -- holding the video timeline, not a stall",
			held.Round(time.Millisecond), s.videoPacketsSeen.Load(), s.videoFramesSeen.Load(), s.elapsedMs()-s.lastIdrAtMs.Load())
	}

	if held < s.videoIdleAfter() {
		return false
	}

	s.videoMu.Lock()
	if s.videoStopped {
		s.videoMu.Unlock()
		return false
	}
	// Re-read under the lock: a packet may have landed between the check
	// above and here, in which case the fragmenter's held AU is younger
	// than this tick thinks and the flush would over-stretch it.
	lastFrame = s.lastVideoFrameAtNs.Load()
	held = now.Sub(time.Unix(0, lastFrame))
	var frag *pipeline.Fragment
	if held >= s.videoIdleAfter() {
		frag = s.frag.IdleFlush(durationToTicks(held))
	}
	if frag != nil {
		s.publish(frag)
	}
	s.videoMu.Unlock()

	if frag == nil {
		return false
	}
	s.keepAlivePartsWritten.Add(1)
	return true
}

// logDepacketizeError writes at most one depacketize line per second,
// carrying however many were suppressed since the last one. Called with
// videoMu held (so the suppressed counter and the timestamp move together
// with no extra synchronization of their own).
//
// A malformed packet was logged unconditionally before. That is fine at
// fourteen per five minutes, which is what 2026-09-15 saw; it is a log
// flood at the loss rate that same presenter's uplink was measured at, and
// a flood hides the one line that matters exactly as well as silence does.
func (s *Session) logDepacketizeError(now time.Time, err error) {
	const depacketizeLogEvery = time.Second
	last := s.depacketizeLogAtNs.Load()
	if last != 0 && now.Sub(time.Unix(0, last)) < depacketizeLogEvery {
		s.depacketizeLogSuppressed.Add(1)
		return
	}
	s.depacketizeLogAtNs.Store(now.UnixNano())
	suppressed := s.depacketizeLogSuppressed.Swap(0)
	if suppressed > 0 {
		log.Printf("pqp-remux: h264 depacketize: %v (%d more suppressed in the last %s; %d total this session)",
			err, suppressed, depacketizeLogEvery, s.videoDepacketizeErrs.Load())
		return
	}
	log.Printf("pqp-remux: h264 depacketize: %v (%d total this session)", err, s.videoDepacketizeErrs.Load())
}

func (s *Session) idleFor(now time.Time) time.Duration {
	last := s.lastVideoFrameAtNs.Load()
	if last == 0 {
		return 0
	}
	return now.Sub(time.Unix(0, last))
}

// Stats is the whole instrumented state of one session at an instant: raw
// running totals, never rates. formatStatsLine turns two of these plus the
// window between them into the periodic log line, and internal/control
// reads the same snapshot for the watchdog's stall detail -- so the numbers
// an operator sees on a routine line and the numbers in a `part-stuck`
// verdict are, by construction, the same numbers.
type Stats struct {
	Subscribed bool

	VideoPacketsSeen     uint64
	VideoFramesSeen      uint64
	VideoKeyframesSeen   uint64
	VideoDepacketizeErrs uint64
	PartsWritten         uint64
	BytesWritten         uint64
	VideoSegmentsWritten uint64
	KeepAlivePartsWrites uint64
	VideoIdle            bool
	// VideoMediaMs/AudioMediaMs and the anchors below are what
	// `timelineRatio` is computed from: how much MEDIA each track has
	// published against how much WALL clock has passed since that
	// track's first part. See Session.videoMediaMs.
	VideoMediaMs     int64
	VideoMediaAnchor time.Time

	AudioPacketsSeen     uint64
	AudioFramesSeen      uint64
	AudioPartsWritten    uint64
	AudioBytesWritten    uint64
	AudioSegmentsWritten uint64
	AudioEnabled         bool
	AudioDead            bool
	AudioRestarts        uint64
	AudioMediaMs         int64
	AudioMediaAnchor     time.Time

	Keyframe keyframe.Stats

	R2Enabled       bool
	R2Uploaded      uint64
	R2Failed        uint64
	R2Dropped       uint64
	R2Queued        int
	R2InFlight      int64
	R2LastLatencyMs int64
	R2MaxLatencyMs  int64

	// Times are wall clock; the zero value means "never".
	Now              time.Time
	StartedAt        time.Time
	LastVideoPacket  time.Time
	LastVideoFrame   time.Time
	LastIdr          time.Time
	LastPart         time.Time
	OpenSegmentMs    int64
	OpenSegmentValid bool
}

// Stats snapshots this session. Safe to call from any goroutine; every
// field behind it is an atomic or an already-synchronized read.
func (s *Session) Stats() Stats {
	// s.now, not time.Now: a test that drives the video path and the
	// keep-alive tick off one synthetic clock must read the same clock
	// back out, or `timelineRatio` compares two unrelated timelines --
	// the exact mistake the `now` field exists to prevent.
	now := s.now()
	st := Stats{
		Subscribed:           s.subscribed.Load(),
		VideoPacketsSeen:     s.videoPacketsSeen.Load(),
		VideoFramesSeen:      s.videoFramesSeen.Load(),
		VideoKeyframesSeen:   s.videoKeyframesSeen.Load(),
		VideoDepacketizeErrs: s.videoDepacketizeErrs.Load(),
		PartsWritten:         s.partsWritten.Load(),
		BytesWritten:         s.bytesWritten.Load(),
		VideoSegmentsWritten: s.videoSegmentsWritten.Load(),
		KeepAlivePartsWrites: s.keepAlivePartsWritten.Load(),
		VideoIdle:            s.videoIdle.Load(),
		VideoMediaMs:         s.videoMediaMs.Load(),
		AudioPacketsSeen:     s.audioPacketsSeen.Load(),
		Now:                  now,
		StartedAt:            s.started,
	}
	if ns := s.videoTimelineAnchorNs.Load(); ns != 0 {
		st.VideoMediaAnchor = time.Unix(0, ns)
	}
	if ns := s.audioTimelineAnchorNs.Load(); ns != 0 {
		st.AudioMediaAnchor = time.Unix(0, ns)
	}
	if s.audioFrag != nil {
		st.AudioEnabled = true
		st.AudioMediaMs = s.audioMediaMs.Load()
		st.AudioFramesSeen = s.audioFramesSeen.Load()
		st.AudioPartsWritten = s.audioPartsWritten.Load()
		st.AudioBytesWritten = s.audioBytesWritten.Load()
		st.AudioSegmentsWritten = s.audioSegmentsWritten.Load()
		st.AudioDead = s.audioDead.Load()
		st.AudioRestarts = s.audioRestarts.Load()
	}
	if kr := s.keyReq.Load(); kr != nil {
		st.Keyframe = kr.Stats()
	}
	if s.r2Writer != nil {
		st.R2Enabled = true
		st.R2Uploaded = s.r2Writer.Uploaded()
		st.R2Failed = s.r2Writer.Failed()
		st.R2Dropped = s.r2Writer.Dropped()
		st.R2Queued = s.r2Writer.Queued()
		st.R2InFlight = s.r2Writer.InFlight()
		st.R2LastLatencyMs = s.r2Writer.LastLatencyMs()
		st.R2MaxLatencyMs = s.r2Writer.MaxLatencyMs()
	}
	if ns := s.lastVideoPacketAtNs.Load(); ns != 0 {
		st.LastVideoPacket = time.Unix(0, ns)
	}
	if ns := s.lastVideoFrameAtNs.Load(); ns != 0 {
		st.LastVideoFrame = time.Unix(0, ns)
	}
	if s.idrSeen.Load() {
		st.LastIdr = s.started.Add(time.Duration(s.lastIdrAtMs.Load()) * time.Millisecond)
	}
	if s.partsWritten.Load() > 0 {
		st.LastPart = s.started.Add(time.Duration(s.lastPartAtMs.Load()) * time.Millisecond)
	}
	if ms, ok := s.OpenSegmentMs(); ok {
		st.OpenSegmentMs, st.OpenSegmentValid = ms, true
	}
	return st
}

// formatStatsLine renders one window: deltas and rates for everything that
// counts, absolute ages for everything that is a "when did X last happen".
// One line, always the same field order, so it greps and diffs.
func formatStatsLine(label string, prev, cur Stats, window time.Duration) string {
	secs := window.Seconds()
	if secs <= 0 {
		secs = 1
	}
	rate := func(a, b uint64) float64 { return float64(b-a) / secs }

	var b strings.Builder
	fmt.Fprintf(&b, "pqp-remux: stats %s window=%s subscribed=%t", label, window.Round(100*time.Millisecond), cur.Subscribed)
	fmt.Fprintf(&b, " | video pkts=+%d (%.1f/s) frames=+%d (%.1f/s) idr=+%d drops=+%d parts=+%d (%.1f/s) segs=+%d keepalive=+%d idle=%t",
		cur.VideoPacketsSeen-prev.VideoPacketsSeen, rate(prev.VideoPacketsSeen, cur.VideoPacketsSeen),
		cur.VideoFramesSeen-prev.VideoFramesSeen, rate(prev.VideoFramesSeen, cur.VideoFramesSeen),
		cur.VideoKeyframesSeen-prev.VideoKeyframesSeen,
		cur.VideoDepacketizeErrs-prev.VideoDepacketizeErrs,
		cur.PartsWritten-prev.PartsWritten, rate(prev.PartsWritten, cur.PartsWritten),
		cur.VideoSegmentsWritten-prev.VideoSegmentsWritten,
		cur.KeepAlivePartsWrites-prev.KeepAlivePartsWrites,
		cur.VideoIdle)
	fmt.Fprintf(&b, " lastPkt=%s lastFrame=%s lastIdr=%s lastPart=%s",
		ago(cur.Now, cur.LastVideoPacket), ago(cur.Now, cur.LastVideoFrame),
		ago(cur.Now, cur.LastIdr), ago(cur.Now, cur.LastPart))
	if cur.OpenSegmentValid {
		fmt.Fprintf(&b, " openSeg=%dms", cur.OpenSegmentMs)
	}
	fmt.Fprintf(&b, " timelineRatio=%s", timelineRatio(cur.Now, cur.VideoMediaAnchor, cur.VideoMediaMs))
	if cur.AudioEnabled {
		fmt.Fprintf(&b, " | audio pkts=+%d frames=+%d parts=+%d (%.1f/s) segs=+%d timelineRatio=%s dead=%t restarts=%d",
			cur.AudioPacketsSeen-prev.AudioPacketsSeen,
			cur.AudioFramesSeen-prev.AudioFramesSeen,
			cur.AudioPartsWritten-prev.AudioPartsWritten, rate(prev.AudioPartsWritten, cur.AudioPartsWritten),
			cur.AudioSegmentsWritten-prev.AudioSegmentsWritten,
			timelineRatio(cur.Now, cur.AudioMediaAnchor, cur.AudioMediaMs),
			cur.AudioDead, cur.AudioRestarts)
	} else {
		fmt.Fprintf(&b, " | audio off pkts=+%d", cur.AudioPacketsSeen-prev.AudioPacketsSeen)
	}
	fmt.Fprintf(&b, " | pli sent=+%d total=%d unanswered=%d lastPli=%s",
		cur.Keyframe.PLIsSent-prev.Keyframe.PLIsSent, cur.Keyframe.PLIsSent,
		cur.Keyframe.PLIsSinceIDR, ago(cur.Now, cur.Keyframe.LastPLIAt))
	if cur.R2Enabled {
		fmt.Fprintf(&b, " | r2 ok=+%d fail=+%d drop=+%d queued=%d inflight=%d lastMs=%d maxMs=%d",
			cur.R2Uploaded-prev.R2Uploaded, cur.R2Failed-prev.R2Failed, cur.R2Dropped-prev.R2Dropped,
			cur.R2Queued, cur.R2InFlight, cur.R2LastLatencyMs, cur.R2MaxLatencyMs)
	}
	return b.String()
}

// timelineRatio renders how much media a track has published against how
// much wall clock passed while it did: 1.00 is a timeline keeping time,
// and anything meaningfully below it means media time is being dropped
// somewhere -- which is what a Chrome tab share did for five minutes on
// 2026-09-15 (0.54 on video beside 0.98 on audio) while every count on
// this line looked healthy. "n/a" until the track has published its first
// part; there is no ratio before there is a timeline.
func timelineRatio(now, anchor time.Time, mediaMs int64) string {
	if anchor.IsZero() {
		return "n/a"
	}
	wallMs := now.Sub(anchor).Milliseconds()
	if wallMs <= 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.2f", float64(mediaMs)/float64(wallMs))
}

// ago renders "how long ago" for a possibly-never timestamp. "never" is a
// real answer and a load-bearing one: "lastFrame=never" and
// "lastFrame=12.4s" are two entirely different incidents.
func ago(now, t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return now.Sub(t).Round(time.Millisecond).String()
}
