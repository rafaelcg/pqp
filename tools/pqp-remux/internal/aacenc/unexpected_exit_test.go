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

// TestEncoderCleanExitAfterCloseReportsNoError is the control case: the
// same shutdown, but Close is called first (intentionalClose), so no
// error should ever reach Errs() -- a normal shutdown must not look like
// a crash.
func TestEncoderCleanExitAfterCloseReportsNoError(t *testing.T) {
	bin := fakeExitingBinary(t, 0)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enc, err := New(ctx, Config{FFmpegPath: bin})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Give the fake process a moment to exit on its own first (it does,
	// immediately) -- Close must still be clean even though the process
	// is already gone by the time it runs.
	time.Sleep(50 * time.Millisecond)
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
