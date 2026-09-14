package aacenc

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// fakeExitingBinary writes a tiny shell script that ignores every
// argument and exits immediately with the given status, standing in for
// ffmpeg crashing or being killed: New only needs something it can Start
// and later Wait on, and this is far cheaper and more deterministic than
// trying to make a real ffmpeg process crash on command.
func fakeExitingBinary(t *testing.T, exitCode int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fakeExitingBinary needs a POSIX shell")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-ffmpeg.sh")
	script := "#!/bin/sh\nexit " + strconv.Itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("writing fake binary: %v", err)
	}
	return path
}

// TestEncoderReportsAnUnexpectedExitThroughErrs is the regression test
// for Farol's "unexpected ffmpeg exit is exposed as clean audio
// completion" finding: a process that exits on its own (crash, killed,
// non-zero status) BEFORE Close is ever called must surface an error on
// Errs(), not just close Frames() silently -- internal/session's
// readEncoderFrames treats that error as tripping the same recovery path
// a WriteSamples failure does (see recoverAudioEncoder), so a crashed
// ffmpeg gets one restart attempt instead of audio quietly going dark
// while everything still "looks enabled".
func TestEncoderReportsAnUnexpectedExitThroughErrs(t *testing.T) {
	bin := fakeExitingBinary(t, 1)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enc, err := New(ctx, Config{FFmpegPath: bin})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	select {
	case err := <-enc.Errs():
		if err == nil {
			t.Fatal("expected a non-nil error describing the unexpected exit")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("expected an error on Errs() after the process exited unexpectedly")
	}

	// Frames() must still close (readADTS always returns eventually).
	select {
	case _, ok := <-enc.Frames():
		if ok {
			t.Fatal("a process that exits immediately should never produce a frame")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Frames() never closed")
	}
}

// TestEncoderCleanExitAfterCloseReportsNoError is the control case for
// TestEncoderReportsAnUnexpectedExitThroughErrs: Close is called
// immediately, the only shape an intentional shutdown ever takes in this
// codebase (Session.Close calls Encoder.Close directly; nothing here
// waits for the process to exit on its own first and calls Close
// afterward -- an earlier version of this test did exactly that, which
// Farol correctly flagged as racy: with a fake process that exits
// instantly regardless of stdin, a fixed sleep before Close is a coin
// flip on whether readADTS's own "Close was not called" report fires
// before Close ever sets intentionalClose. Calling Close right away
// removes that race by construction: intentionalClose is the very first
// thing Close does, strictly before anything that could let the
// process's exit become observable to readADTS.
func TestEncoderCleanExitAfterCloseReportsNoError(t *testing.T) {
	bin := fakeExitingBinary(t, 0)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enc, err := New(ctx, Config{FFmpegPath: bin})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := enc.Close(); err != nil {
		// The fake process exits 0, so Close's own return (the process's
		// Wait error) should be nil.
		t.Fatalf("Close: %v", err)
	}

	select {
	case err, ok := <-enc.Errs():
		if ok {
			t.Fatalf("expected no error after an intentional Close, got: %v", err)
		}
	default:
	}
}

// TestEncoderContextCancellationIsTreatedAsIntentional is the regression
// test for Farol's "notification-ordering gap": cancelling ctx (not
// calling Close) is exactly what kills the ffmpeg subprocess first in
// internal/session's own shutdown sequence (cancel() runs before
// sess.Close() -- see Session.Close's doc comment), so a ctx-triggered
// exit must be treated as intentional too, not just an explicit Close
// call, or an ordinary session shutdown would misreport itself as an
// encoder crash and could even attempt a pointless restart mid-teardown.
// Uses a real, long-running ffmpeg (not the instant fake binary) so
// cancellation genuinely races the process's exit, the same shape a live
// session's shutdown has.
func TestEncoderContextCancellationIsTreatedAsIntentional(t *testing.T) {
	requireFFmpeg(t)

	ctx, cancel := context.WithCancel(context.Background())
	enc, err := New(ctx, Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	cancel() // not enc.Close() -- mirrors Session's own shutdown order exactly

	// Wait for the definitive completion signal (Frames() closing) first;
	// readADTS's own errs-send (if any) always happens strictly before
	// that close (see its doc comment), so a non-blocking check of Errs()
	// right after is enough -- no need for a second bounded wait.
	select {
	case _, ok := <-enc.Frames():
		if ok {
			t.Fatal("expected Frames() to close, not deliver a frame, after ctx cancellation with no input ever written")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Frames() never closed after ctx cancellation")
	}

	select {
	case err, ok := <-enc.Errs():
		if ok {
			t.Fatalf("a ctx-cancellation-triggered exit must not be reported as an unexpected error, got: %v", err)
		}
	default:
	}
}

// TestEncoderCloseNeverHangsWhenNobodyReadsFrames is the regression test
// for the "Close can deadlock" finding: readADTS's blocking send would
// previously wait forever on a full, unread Frames() channel, and Close
// waited for readADTS to finish -- so a consumer that stops reading could
// hang Close indefinitely. This never reads Frames() at all.
func TestEncoderCloseNeverHangsWhenNobodyReadsFrames(t *testing.T) {
	requireFFmpeg(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	enc, err := New(ctx, Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Enough audio to overflow the 32-frame buffer several times over if
	// nothing ever reads Frames().
	pcm := sineWavePCM(3.0)
	if err := enc.WriteSamples(pcm); err != nil {
		t.Fatalf("WriteSamples: %v", err)
	}

	done := make(chan struct{})
	go func() {
		enc.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Close hung with nobody reading Frames() -- the closeRequested bailout did not work")
	}
}
