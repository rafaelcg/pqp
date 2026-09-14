// Package aacenc encodes 48kHz stereo PCM (internal/audiomix's mix output)
// into AAC-LC by piping it through a long-lived `ffmpeg` subprocess, and
// parses ffmpeg's ADTS output back into raw (header-stripped) AAC access
// units ready to become CMAF samples.
//
// Why ffmpeg over a Go AAC encoder: unlike Opus decode (see
// internal/audiomix's package doc comment for that choice), there is no
// maintained pure-Go AAC-LC encoder to reach for -- the handful of
// FAAC-derived options are abandoned cgo wrappers, not pure Go, and a
// from-scratch MDCT + TNS + quantization + Huffman encoder is a project of
// its own, not what L1.3 budgets for. ffmpeg's native `aac` encoder is
// maintained, already an ordinary system package (`apt-get install
// ffmpeg`, one line in the box's provisioning, same shape as any other
// runtime dependency this repo already documents), and cheap: encoding 30s
// of 48kHz stereo audio measured at about 0.26s of user CPU locally (an
// Apple Silicon laptop, not the production box -- see the PR description
// for the exact command and numbers), i.e. roughly 0.87% of one core
// sustained. Comfortably inside the plan's "audio mix and AAC about 0.05
// of a core for a busy stage" floor (section 5) even before accounting for
// the fact that a party has one shared mix, not one encode per listener.
package aacenc

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"sync"
	"sync/atomic"
)

// SampleRate/Channels match internal/audiomix.SampleRate/Channels exactly:
// this package encodes whatever PCM it is handed without resampling, and
// both packages are meant to be wired directly together.
const (
	SampleRate = 48000
	Channels   = 2
)

// SamplesPerFrame is ffmpeg's native "aac" encoder's fixed AAC-LC frame
// size (1024 samples per channel), independent of sample rate. Every
// Frame this package emits carries this many samples; the caller (the
// audio pipeline's fragmenter) uses it directly as the CMAF sample
// duration in the 48kHz timescale, where duration-in-ticks and
// sample-count coincide by construction (48000/1024 is not an integer
// frame rate, which is fine: CMAF durations are per-sample, not a fixed
// frame rate).
const SamplesPerFrame = 1024

// PrimingSamples is the nominal one-frame encoder delay ffmpeg's native
// AAC-LC encoder introduces (the MDCT's own look-ahead): the first Frame
// this package ever emits corresponds to input samples starting at
// -PrimingSamples relative to what was Written first, not 0. This is a
// documented constant for the encoder, not independently re-measured here
// (e.g. from the `iTunSMPB`-style delay metadata ffmpeg can be asked to
// write) -- see the README's "Codec choices and their CPU cost" for what
// would tighten this if the plan's 40ms sync budget ever gets close to it.
// A caller building CMAF sample timing should subtract this from the
// first frame's nominal position.
const PrimingSamples = SamplesPerFrame

// bytesPerSample is one interleaved stereo float32 sample pair: 4 bytes
// per channel.
const bytesPerSample = 4 * Channels

// Frame is one decoded ADTS frame's raw payload (its ADTS header
// stripped): a single CMAF audio sample, always SamplesPerFrame samples.
type Frame struct {
	// Data is the raw AAC-LC access unit, ADTS header (and CRC, if
	// present) removed: exactly what a CMAF `mdat` sample wants, and what
	// an `esds` box's AudioSpecificConfig already describes out of band.
	Data []byte
}

// Config is what New needs to start the ffmpeg subprocess.
type Config struct {
	// FFmpegPath is the binary to run; "ffmpeg" (resolved via PATH) when
	// empty.
	FFmpegPath string
	// BitrateKbps is the target AAC bitrate. ffmpeg's native encoder is
	// VBR-capable internally but a `-b:a` target keeps the live bitrate
	// bounded and predictable, which matters more here than a few percent
	// of quality: this stream has to fit the same capacity budget
	// (section 5 of the plan) as everything else the box serves. Defaults
	// to 128 when zero.
	BitrateKbps int
}

// Encoder wraps one long-lived ffmpeg process: PCM in via Write, AAC
// frames out via Frames(). One Encoder per remux session's audio track;
// not safe for concurrent Write calls (matching every other single-writer
// pipeline stage in this codebase -- see internal/pipeline.Fragmenter's
// own doc comment), though Write and reading Frames()/Errs() are safe
// concurrently with each other since they touch different pipes.
type Encoder struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	frames chan Frame
	errs   chan error

	// intentionalClose is set (before stdin is closed) by Close, so
	// readADTS can tell "we asked ffmpeg to stop" apart from "ffmpeg
	// stopped on its own" once its read loop ends -- both look like the
	// same EOF/closed-pipe condition from inside that loop, and only this
	// flag distinguishes a normal shutdown from an unexpected exit worth
	// reporting through Errs().
	intentionalClose atomic.Bool
	// closeRequested lets a blocked "deliver this frame" send abandon
	// itself once Close is underway, so a consumer that has stopped
	// reading Frames() (or never started) cannot make Close hang forever
	// waiting on a full channel. See readADTS's send loop.
	closeRequested chan struct{}
	// processDone closes once cmd.Wait() returns, called exactly once,
	// from readADTS's own goroutine after its read loop ends -- the
	// single place this Encoder ever calls Wait, so Close does not need
	// (and must not attempt) a second call.
	processDone chan struct{}
	waitErr     error // valid only after processDone closes

	closeOnce sync.Once
	closeErr  error
}

// New starts the ffmpeg subprocess and its ADTS-reading goroutine.
// ctx.Done() kills the process (exec.CommandContext); Close is still the
// normal, clean shutdown path and should be called exactly once when the
// session ends regardless of ctx.
func New(ctx context.Context, cfg Config) (*Encoder, error) {
	bin := cfg.FFmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	kbps := cfg.BitrateKbps
	if kbps == 0 {
		kbps = 128
	}

	cmd := exec.CommandContext(ctx, bin,
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-f", "f32le", "-ar", fmt.Sprintf("%d", SampleRate), "-ac", fmt.Sprintf("%d", Channels),
		"-i", "pipe:0",
		"-c:a", "aac", "-b:a", fmt.Sprintf("%dk", kbps),
		"-f", "adts", "pipe:1",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("aacenc: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("aacenc: stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("aacenc: starting %q: %w", bin, err)
	}

	e := &Encoder{
		cmd:            cmd,
		stdin:          stdin,
		frames:         make(chan Frame, 32),
		errs:           make(chan error, 1),
		closeRequested: make(chan struct{}),
		processDone:    make(chan struct{}),
	}
	go e.readADTS(stdout)
	return e, nil
}

// WriteSamples feeds interleaved stereo float32 PCM (SampleRate,
// Channels) to the encoder. Blocks only as long as the OS pipe buffer is
// full and ffmpeg is behind -- ordinary backpressure, identical to
// writing to any subprocess's stdin -- which is why the caller (the
// session's audio pacer) must never hold the video pipeline's own lock or
// goroutine while calling this; see Session's doc comment.
func (e *Encoder) WriteSamples(pcm []float32) error {
	buf := make([]byte, len(pcm)*4)
	for i, v := range pcm {
		putFloat32LE(buf[i*4:], v)
	}
	_, err := e.stdin.Write(buf)
	return err
}

// Frames returns the channel Frame values arrive on, in encode order.
// Closed once the subprocess's stdout is exhausted, whether from Close or
// the process exiting on its own.
func (e *Encoder) Frames() <-chan Frame { return e.frames }

// Errs returns a channel carrying at most one error: the first ADTS parse
// failure this Encoder's reader goroutine saw. Reading it is optional
// (Frames() still closes cleanly either way); a caller that wants to
// count/log failures should select on it alongside Frames().
func (e *Encoder) Errs() <-chan error { return e.errs }

// Close stops feeding the subprocess (closing stdin, which is ffmpeg's own
// signal to flush and exit) and waits for its ADTS reader goroutine to
// both finish draining stdout AND observe the process's exit (Wait),
// returning that exit error. Safe to call more than once; every call
// after the first returns the same result.
//
// This never deadlocks even if the caller has stopped reading Frames():
// closeRequested (closed here) lets readADTS's blocked "deliver this
// frame" send abandon itself instead of waiting forever on a full,
// unread channel -- see readADTS's own send loop for why that matters
// and what it costs (the frame in flight at that exact moment, at most).
func (e *Encoder) Close() error {
	e.closeOnce.Do(func() {
		e.intentionalClose.Store(true)
		_ = e.stdin.Close()
		close(e.closeRequested)
		<-e.processDone
		e.closeErr = e.waitErr
	})
	return e.closeErr
}

// readADTS is the only goroutine that ever reads stdout or calls
// cmd.Wait (exec.Cmd forbids calling Wait more than once, and calling it
// before stdout is fully drained risks losing buffered output -- see the
// stdlib's own StdoutPipe doc comment -- so both live in this one
// sequential flow). Once its read loop ends for any reason, it waits for
// the process, then -- unless Close asked for this shutdown
// (intentionalClose) -- reports whatever looks like an unexpected exit
// through Errs(), so a caller (internal/session) can tell "the encoder
// finished because we told it to" apart from "the encoder died on its
// own" instead of both looking like an ordinary, silent end of Frames().
func (e *Encoder) readADTS(r io.Reader) {
	defer close(e.frames)
	br := bufio.NewReaderSize(r, 64*1024)

	var readErr error
readLoop:
	for {
		frame, err := readOneADTSFrame(br)
		if err != nil {
			readErr = err
			break
		}
		// Prefer delivering without ever consulting closeRequested: a
		// consumer that is actively draining Frames() (the normal case,
		// including for the whole tail of an intentional shutdown, which
		// wants every buffered frame delivered) must never lose a frame
		// to closeRequested winning an arbitrary select race. Only fall
		// back to the closeRequested-aware select once the channel is
		// actually full, meaning nothing is being read right now.
		select {
		case e.frames <- frame:
			continue
		default:
		}
		select {
		case e.frames <- frame:
		case <-e.closeRequested:
			// Shutdown is in progress and nobody appears to be reading
			// Frames(): stop the whole loop rather than risk blocking
			// again on the very next frame (which would also block
			// Close, which waits on processDone below). Whatever was
			// still pending, including this frame and any further ADTS
			// output, is lost -- an accepted cost of an
			// already-abnormal "consumer stopped" shutdown.
			break readLoop
		}
	}

	waitErr := e.cmd.Wait()
	e.waitErr = waitErr
	close(e.processDone)

	if e.intentionalClose.Load() {
		return
	}

	// Not asked for: either the read loop hit a genuine parse/read error,
	// or ffmpeg exited (cleanly or not) without Close ever being called.
	// Either is worth reporting -- internal/session treats this the same
	// as a WriteSamples failure, attempting one restart before giving up
	// (see recoverAudioEncoder) -- so an ffmpeg crash never just looks
	// like a quiet, successful end of the audio track.
	var reportErr error
	switch {
	case readErr != nil && !errors.Is(readErr, io.EOF):
		reportErr = fmt.Errorf("aacenc: reading ADTS output: %w", readErr)
	case waitErr != nil:
		reportErr = fmt.Errorf("aacenc: ffmpeg exited unexpectedly: %w", waitErr)
	default:
		// Plain EOF on stdout with a clean exit status, but Close was
		// never called: ffmpeg closed its output on its own, which is
		// still not something this Encoder was told to expect.
		reportErr = errors.New("aacenc: ffmpeg's output ended unexpectedly (Close was not called)")
	}
	select {
	case e.errs <- reportErr:
	default:
	}
}

func putFloat32LE(b []byte, v float32) {
	u := math.Float32bits(v)
	b[0] = byte(u)
	b[1] = byte(u >> 8)
	b[2] = byte(u >> 16)
	b[3] = byte(u >> 24)
}
