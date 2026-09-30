// WASAPI process loopback: the sound of one process tree, or of everything
// except one process tree, as 48 kHz stereo float32 in 10 ms chunks.
//
// This is the part of Microsoft's "ApplicationLoopback" sample that matters,
// without WRL/WIL and without Media Foundation work queues, so it builds with
// nothing but the Windows SDK. The capture runs on its own thread; the caller
// only ever sees chunks and events through the two sinks.
#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

namespace pqp {

enum class LoopbackMode {
  // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE: a window share, the
  // owning app and its children.
  IncludeTargetTree,
  // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE: a screen share,
  // everything but pqp (our renderer and audio service are our children).
  ExcludeTargetTree,
};

constexpr UINT32 kSampleRate = 48000;
constexpr UINT32 kChannels = 2;
// 10 ms. The renderer's worklet does not care about the size, but a fixed one
// makes the latency arithmetic on both sides the same arithmetic.
constexpr UINT32 kChunkFrames = kSampleRate / 100;

struct CaptureEvent {
  enum class Type { Started, Error, Ended };
  Type type = Type::Ended;
  // Where it failed: com, activate, initialize, service, event, start, wait,
  // read, thread. Empty on Started and Ended.
  const char* stage = "";
  HRESULT hr = S_OK;
  // Whether Initialize took AUTOCONVERTPCM. The sample never passes it (it
  // lands in the periodicity argument), so the fallback is exactly its shape.
  bool autoConvert = false;
  UINT32 bufferFrames = 0;
  uint64_t packets = 0;
  uint64_t frames = 0;
  uint64_t silentPackets = 0;
  uint64_t discontinuities = 0;
};

class LoopbackCapture {
 public:
  // Called on the capture thread. Must not block.
  using ChunkSink = std::function<void(std::vector<float>&&)>;
  using EventSink = std::function<void(const CaptureEvent&)>;

  LoopbackCapture(DWORD pid, LoopbackMode mode, ChunkSink chunks,
                  EventSink events);
  ~LoopbackCapture();

  LoopbackCapture(const LoopbackCapture&) = delete;
  LoopbackCapture& operator=(const LoopbackCapture&) = delete;

  // False when the thread or its events could not be created; nothing runs.
  bool Start();
  // Asks the thread to finish and returns at once; it does not wait for it.
  // Safe from any thread, idempotent, and a no-op before Start(). Every wait
  // the capture thread makes (the activation round trip included) also
  // watches this signal, so a cancelled capture unwinds in milliseconds, but
  // "in milliseconds" is the thread's business: a caller that must not be
  // held up (the JavaScript thread) cancels here and joins somewhere else.
  void Cancel();
  // Cancel(), then join the thread, so the Ended event has been handed to the
  // sink by the time this returns. Idempotent. Blocks for as long as the
  // thread takes to unwind; call it from a thread that may wait.
  void Stop();

 private:
  void Run();
  void RunCapture(CaptureEvent& stats);
  void Fail(const char* stage, HRESULT hr);
  void Flush(std::vector<float>& pending);

  const DWORD pid_;
  const LoopbackMode mode_;
  ChunkSink chunks_;
  EventSink events_;
  HANDLE stop_ = nullptr;
  HANDLE sampleReady_ = nullptr;
  std::thread thread_;
  std::atomic<bool> started_{false};
};

}  // namespace pqp
