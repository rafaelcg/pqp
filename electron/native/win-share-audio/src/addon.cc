// The N-API surface of the Windows share-audio add-on.
//
// Plain C N-API rather than node-addon-api: five functions do not justify a
// dependency, and the C API is the one whose ABI is promised across every
// Node and Electron that ships NAPI_VERSION 8, which is what lets one binary
// built against Node's headers load inside Electron 44 (and 45, and 46).
//
//   startCapture(pid, "include" | "exclude", onChunk, onEvent) -> { stop() }
//     onChunk(Float32Array)  480 interleaved stereo frames, 48 kHz, 10 ms
//     onEvent({ type: "started" | "error" | "ended", stage, hr, ... })
//   windowOwner(hwnd) -> { pid, childPids } | null
//   listProcesses() -> [{ pid, parentPid, exe }]
//   processCreationTime(pid) -> ms since 1601 | null
//   abi -> 1
#include <node_api.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include "loopback_capture.h"
#include "process_info.h"

namespace {

constexpr uint32_t kAbi = 1;
// 50 chunks is 500 ms the JS thread has not picked up. Past that it is not
// keeping up, and a share is better served by dropping audio it would only
// play late than by queueing it without bound.
constexpr int kMaxInFlightChunks = 50;

struct Message {
  enum class Kind { Chunk, Event };
  Kind kind = Kind::Chunk;
  std::vector<float> samples;
  pqp::CaptureEvent event;
};

// Owned by the threadsafe function and freed in its finalizer, which runs
// only after every queued message has been delivered. The capture thread has
// been joined before that can happen, so nothing else still points here.
struct Callbacks {
  napi_ref onEvent = nullptr;
  std::atomic<int> inFlight{0};
  std::atomic<uint64_t> dropped{0};
  // Set by stop() before anything else. From then on the capture thread's
  // audio is dropped at the source instead of queued for a JS thread that
  // has already been told the share is over; its final events still go out.
  std::atomic<bool> cancelled{false};
};

// THE STOP HANDSHAKE, because the JS thread must never wait for the capture
// thread, and the capture thread must never outlive what it calls into.
//
//   JS thread, stop():      1. callbacks->cancelled = true   (chunks dropped)
//                           2. capture->Cancel()             (signal only)
//                           3. hand {capture, tsfn} to `cleaner`; return.
//   cleaner thread:         4. capture->Stop()               (the join)
//                           5. release the threadsafe function, which is
//                              the LAST thing that touches it.
//   JS thread, later:       6. the queue drains (the final "ended" event
//                              included), then FinalizeCallbacks frees the
//                              Callbacks the capture thread posted into.
//
// Nothing is freed while a thread can still reach it: `Callbacks` dies only
// after the release in 5, which only happens after the join in 4, and the
// capture thread is the only other user. The Session owns the `cleaner`
// thread and joins it in its finalizer, so a stop that is still unwinding at
// garbage collection or at environment teardown is waited for there (where
// waiting is unavoidable) rather than detached and left to race the process
// going away. A second stop() finds `stopped` set and does nothing.
struct Session {
  napi_threadsafe_function tsfn = nullptr;
  Callbacks* callbacks = nullptr;
  std::shared_ptr<pqp::LoopbackCapture> capture;
  std::thread cleaner;
  bool stopped = false;
};

void SetNamed(napi_env env, napi_value object, const char* name,
              napi_value value) {
  napi_set_named_property(env, object, name, value);
}

void SetString(napi_env env, napi_value object, const char* name,
               const char* value) {
  napi_value out;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out) == napi_ok) {
    SetNamed(env, object, name, out);
  }
}

void SetNumber(napi_env env, napi_value object, const char* name,
               double value) {
  napi_value out;
  if (napi_create_double(env, value, &out) == napi_ok) {
    SetNamed(env, object, name, out);
  }
}

void SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value out;
  if (napi_get_boolean(env, value, &out) == napi_ok) {
    SetNamed(env, object, name, out);
  }
}

const char* TypeName(pqp::CaptureEvent::Type type) {
  switch (type) {
    case pqp::CaptureEvent::Type::Started:
      return "started";
    case pqp::CaptureEvent::Type::Error:
      return "error";
    case pqp::CaptureEvent::Type::Ended:
      return "ended";
  }
  return "ended";
}

napi_value MakeEvent(napi_env env, const pqp::CaptureEvent& event,
                     uint64_t dropped) {
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok) {
    return nullptr;
  }
  SetString(env, object, "type", TypeName(event.type));
  SetString(env, object, "stage", event.stage);
  // Unsigned, so 0x88890010 reads as itself in the JS console and not as a
  // negative number somebody has to convert before searching for it.
  SetNumber(env, object, "hr", static_cast<double>(static_cast<uint32_t>(event.hr)));
  SetBool(env, object, "autoConvert", event.autoConvert);
  SetNumber(env, object, "bufferFrames", event.bufferFrames);
  SetNumber(env, object, "packets", static_cast<double>(event.packets));
  SetNumber(env, object, "frames", static_cast<double>(event.frames));
  SetNumber(env, object, "silentPackets", static_cast<double>(event.silentPackets));
  SetNumber(env, object, "discontinuities", static_cast<double>(event.discontinuities));
  SetNumber(env, object, "dropped", static_cast<double>(dropped));
  return object;
}

void CallJs(napi_env env, napi_value onChunk, void* context, void* data) {
  std::unique_ptr<Message> message(static_cast<Message*>(data));
  Callbacks* callbacks = static_cast<Callbacks*>(context);
  if (message->kind == Message::Kind::Chunk) {
    callbacks->inFlight.fetch_sub(1);
  }
  // Null env: the function is being torn down and the message only needs
  // freeing, which the unique_ptr does.
  if (env == nullptr) {
    return;
  }
  napi_value receiver;
  napi_get_undefined(env, &receiver);
  napi_value fn = onChunk;
  napi_value argv[1] = {nullptr};
  if (message->kind == Message::Kind::Chunk) {
    const size_t bytes = message->samples.size() * sizeof(float);
    void* raw = nullptr;
    napi_value buffer;
    if (napi_create_arraybuffer(env, bytes, &raw, &buffer) != napi_ok) {
      return;
    }
    // A copy, not napi_create_external_arraybuffer: Electron's V8 memory cage
    // refuses external backing stores, and 3.8 KB a chunk costs nothing.
    std::memcpy(raw, message->samples.data(), bytes);
    if (napi_create_typedarray(env, napi_float32_array, message->samples.size(),
                               buffer, 0, &argv[0]) != napi_ok) {
      return;
    }
  } else {
    if (!callbacks->onEvent ||
        napi_get_reference_value(env, callbacks->onEvent, &fn) != napi_ok ||
        fn == nullptr) {
      return;
    }
    argv[0] = MakeEvent(env, message->event, callbacks->dropped.load());
    if (argv[0] == nullptr) {
      return;
    }
  }
  if (fn == nullptr) {
    return;
  }
  napi_value result;
  if (napi_call_function(env, receiver, fn, 1, argv, &result) ==
      napi_pending_exception) {
    // The host's callbacks catch their own errors. One that still escapes
    // must not become an uncaught exception that takes the audio process,
    // and every other share it serves, down with it.
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
  }
}

void FinalizeCallbacks(napi_env env, void* data, void*) {
  Callbacks* callbacks = static_cast<Callbacks*>(data);
  if (callbacks->onEvent) {
    napi_delete_reference(env, callbacks->onEvent);
  }
  delete callbacks;
}

// Steps 4 and 5 of the handshake above: join the (already cancelled) capture
// thread, then give the threadsafe function back. `Stop` joins, so after it
// returns the capture thread has posted its last message and will call into
// the function no more.
void FinishStop(std::shared_ptr<pqp::LoopbackCapture>& capture,
                napi_threadsafe_function tsfn) {
  if (capture) {
    capture->Stop();
    capture.reset();
  }
  if (tsfn) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  }
}

// Used where waiting is the point or the only choice: the finalizer, and a
// capture that never started. The caller may block here.
void StopSessionBlocking(Session* session) {
  if (session->stopped) {
    return;
  }
  session->stopped = true;
  if (session->callbacks) {
    session->callbacks->cancelled.store(true);
  }
  napi_threadsafe_function tsfn = session->tsfn;
  session->tsfn = nullptr;
  FinishStop(session->capture, tsfn);
}

// `stop()` from JavaScript: signal, and let another thread do the waiting.
void StopSessionAsync(Session* session) {
  if (session->stopped) {
    return;
  }
  session->stopped = true;
  napi_threadsafe_function tsfn = session->tsfn;
  session->tsfn = nullptr;
  std::shared_ptr<pqp::LoopbackCapture> capture = std::move(session->capture);
  if (session->callbacks) {
    session->callbacks->cancelled.store(true);
  }
  if (!capture) {
    FinishStop(capture, tsfn);
    return;
  }
  capture->Cancel();
  try {
    // `capture` is copied into the thread, so if the thread cannot be made
    // this function still owns it and finishes the stop itself below.
    session->cleaner = std::thread([capture, tsfn]() mutable {
      FinishStop(capture, tsfn);
    });
    return;
  } catch (const std::system_error&) {
    // Out of threads: block, exactly as before this existed, rather than
    // leak a running capture.
  }
  FinishStop(capture, tsfn);
}

void FinalizeSession(napi_env, void* data, void*) {
  Session* session = static_cast<Session*>(data);
  StopSessionBlocking(session);
  if (session->cleaner.joinable()) {
    session->cleaner.join();
  }
  delete session;
}

napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

napi_value Stop(napi_env env, napi_callback_info info) {
  napi_value self;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr) != napi_ok) {
    return nullptr;
  }
  void* data = nullptr;
  if (napi_unwrap(env, self, &data) != napi_ok || data == nullptr) {
    return Throw(env, "stop() called on something that is not a capture");
  }
  StopSessionAsync(static_cast<Session*>(data));
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value StartCapture(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc < 4) {
    return Throw(env, "startCapture(pid, mode, onChunk, onEvent)");
  }
  uint32_t pid = 0;
  if (napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) {
    return Throw(env, "pid must be a positive integer");
  }
  char mode[16] = {0};
  size_t modeLength = 0;
  if (napi_get_value_string_utf8(env, argv[1], mode, sizeof(mode),
                                 &modeLength) != napi_ok) {
    return Throw(env, "mode must be \"include\" or \"exclude\"");
  }
  pqp::LoopbackMode loopbackMode;
  if (std::strcmp(mode, "include") == 0) {
    loopbackMode = pqp::LoopbackMode::IncludeTargetTree;
  } else if (std::strcmp(mode, "exclude") == 0) {
    loopbackMode = pqp::LoopbackMode::ExcludeTargetTree;
  } else {
    return Throw(env, "mode must be \"include\" or \"exclude\"");
  }
  napi_valuetype chunkType;
  napi_valuetype eventType;
  napi_typeof(env, argv[2], &chunkType);
  napi_typeof(env, argv[3], &eventType);
  if (chunkType != napi_function || eventType != napi_function) {
    return Throw(env, "onChunk and onEvent must be functions");
  }

  Callbacks* callbacks = new Callbacks();
  if (napi_create_reference(env, argv[3], 1, &callbacks->onEvent) != napi_ok) {
    delete callbacks;
    return Throw(env, "could not hold onEvent");
  }
  napi_value resourceName;
  napi_create_string_utf8(env, "pqpShareAudio", NAPI_AUTO_LENGTH, &resourceName);
  napi_threadsafe_function tsfn = nullptr;
  // Queue size 0 (unbounded) on purpose: every call is non-blocking, and the
  // bound that matters is `kMaxInFlightChunks`, applied before posting. A
  // blocking call here could deadlock stop(), which joins the capture thread
  // from the very thread that drains this queue.
  if (napi_create_threadsafe_function(env, argv[2], nullptr, resourceName, 0, 1,
                                      callbacks, FinalizeCallbacks, callbacks,
                                      CallJs, &tsfn) != napi_ok) {
    napi_delete_reference(env, callbacks->onEvent);
    delete callbacks;
    return Throw(env, "could not create the delivery queue");
  }

  Session* session = new Session();
  session->tsfn = tsfn;
  session->callbacks = callbacks;

  auto onChunk = [tsfn, callbacks](std::vector<float>&& samples) {
    if (callbacks->cancelled.load()) {
      return;
    }
    if (callbacks->inFlight.load() >= kMaxInFlightChunks) {
      callbacks->dropped.fetch_add(1);
      return;
    }
    Message* message = new Message();
    message->kind = Message::Kind::Chunk;
    message->samples = std::move(samples);
    callbacks->inFlight.fetch_add(1);
    if (napi_call_threadsafe_function(tsfn, message, napi_tsfn_nonblocking) !=
        napi_ok) {
      callbacks->inFlight.fetch_sub(1);
      callbacks->dropped.fetch_add(1);
      delete message;
    }
  };
  auto onEvent = [tsfn](const pqp::CaptureEvent& event) {
    Message* message = new Message();
    message->kind = Message::Kind::Event;
    message->event = event;
    if (napi_call_threadsafe_function(tsfn, message, napi_tsfn_nonblocking) !=
        napi_ok) {
      delete message;
    }
  };
  session->capture = std::make_shared<pqp::LoopbackCapture>(
      static_cast<DWORD>(pid), loopbackMode, onChunk, onEvent);

  napi_value handle;
  napi_value stop;
  if (napi_create_object(env, &handle) != napi_ok ||
      napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr,
                           &stop) != napi_ok ||
      napi_set_named_property(env, handle, "stop", stop) != napi_ok ||
      napi_wrap(env, handle, session, FinalizeSession, nullptr, nullptr) !=
          napi_ok) {
    StopSessionBlocking(session);
    delete session;
    return Throw(env, "could not create the capture handle");
  }
  if (!session->capture->Start()) {
    // The handle's finalizer frees the session; stopping now releases the
    // queue so the process is not held open by a capture that never ran.
    StopSessionBlocking(session);
    return Throw(env, "the capture thread could not start");
  }
  return handle;
}

napi_value WindowOwner(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int64_t raw = 0;
  napi_value null;
  napi_get_null(env, &null);
  if (argc < 1 || napi_get_value_int64(env, argv[0], &raw) != napi_ok ||
      raw <= 0) {
    return null;
  }
  pqp::WindowOwner owner;
  if (!pqp::OwnerOfWindow(reinterpret_cast<HWND>(static_cast<intptr_t>(raw)),
                          &owner)) {
    return null;
  }
  napi_value out;
  napi_create_object(env, &out);
  SetNumber(env, out, "pid", owner.pid);
  napi_value children;
  napi_create_array_with_length(env, owner.childPids.size(), &children);
  for (size_t i = 0; i < owner.childPids.size(); ++i) {
    napi_value pid;
    napi_create_uint32(env, owner.childPids[i], &pid);
    napi_set_element(env, children, static_cast<uint32_t>(i), pid);
  }
  SetNamed(env, out, "childPids", children);
  return out;
}

napi_value ListProcesses(napi_env env, napi_callback_info) {
  const std::vector<pqp::ProcessEntry> processes = pqp::ListProcesses();
  napi_value out;
  napi_create_array_with_length(env, processes.size(), &out);
  for (size_t i = 0; i < processes.size(); ++i) {
    napi_value entry;
    napi_create_object(env, &entry);
    SetNumber(env, entry, "pid", processes[i].pid);
    SetNumber(env, entry, "parentPid", processes[i].parentPid);
    SetString(env, entry, "exe", processes[i].exe.c_str());
    napi_set_element(env, out, static_cast<uint32_t>(i), entry);
  }
  return out;
}

napi_value ProcessCreationTime(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value null;
  napi_get_null(env, &null);
  uint32_t pid = 0;
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok) {
    return null;
  }
  uint64_t ticks = 0;
  if (!pqp::ProcessCreationTime(pid, &ticks)) {
    return null;
  }
  napi_value out;
  napi_create_double(env, static_cast<double>(ticks / 10000), &out);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value abi;
  napi_create_uint32(env, kAbi, &abi);
  napi_property_descriptor properties[] = {
      {"startCapture", nullptr, StartCapture, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"windowOwner", nullptr, WindowOwner, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"listProcesses", nullptr, ListProcesses, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"processCreationTime", nullptr, ProcessCreationTime, nullptr, nullptr,
       nullptr, napi_enumerable, nullptr},
      {"abi", nullptr, nullptr, nullptr, nullptr, abi, napi_enumerable,
       nullptr},
  };
  napi_define_properties(env, exports,
                         sizeof(properties) / sizeof(properties[0]),
                         properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
