#include "loopback_capture.h"

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <propidl.h>

#include <system_error>
#include <utility>

// The process loopback types arrived in SDK 10.0.20348. MSVC on the CI image
// has them; mingw (used only to syntax-check this file off Windows) does not.
// The layout below is copied from audioclientactivationparams.h and must stay
// byte-identical to it: it is handed to the OS as an opaque blob.
#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define PQP_HAVE_ACTIVATION_PARAMS 1
#endif
#endif

#ifndef PQP_HAVE_ACTIVATION_PARAMS
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

namespace pqp {
namespace {

// 100 ms of buffer. The thread drains on every event, so this is headroom for
// a late wake-up, not latency: what we read is whatever arrived since the
// last event.
constexpr REFERENCE_TIME kBufferDuration = 1000000;
// Activation is a round trip to the audio service. It answers in
// milliseconds; five seconds means it is not going to.
constexpr DWORD kActivateTimeoutMs = 5000;
// Process loopback delivers nothing at all while the target is silent (no
// silent packets, no events), so a quiet wait is normal and only the stop
// event ends the loop.
constexpr DWORD kWaitMs = 250;

using ActivateFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*,
                                    IActivateAudioInterfaceCompletionHandler*,
                                    IActivateAudioInterfaceAsyncOperation**);

// Looked up rather than linked: the export exists from Windows 8, but a
// missing symbol at load time would take the whole module down with it, and
// "the add-on did not load" is a worse answer than "activation failed".
ActivateFn LoadActivate() {
  static const ActivateFn fn = []() -> ActivateFn {
    HMODULE module =
        LoadLibraryExW(L"Mmdevapi.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) {
      return nullptr;
    }
    return reinterpret_cast<ActivateFn>(reinterpret_cast<void*>(
        GetProcAddress(module, "ActivateAudioInterfaceAsync")));
  }();
  return fn;
}

// The completion handler ActivateAudioInterfaceAsync calls back into. It has
// to be agile (the call can complete on any thread), and all it does is
// signal: the result is read off the operation afterwards, on our thread.
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler,
                                public IAgileObject {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

  bool ok() const { return done_ != nullptr; }
  HANDLE done() const { return done_; }

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refs_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG left = static_cast<ULONG>(InterlockedDecrement(&refs_));
    if (left == 0) {
      delete this;
    }
    return left;
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done_);
    return S_OK;
  }

 private:
  ~ActivationHandler() {
    if (done_) {
      CloseHandle(done_);
    }
  }

  LONG refs_ = 1;
  HANDLE done_;
};

// `stop` interrupts the wait: a share ended while the audio service is slow
// to answer must not hold the caller of Stop(), who joins this thread.
HRESULT ActivateProcessLoopback(DWORD pid, LoopbackMode mode, HANDLE stop,
                                IAudioClient** out) {
  *out = nullptr;
  const ActivateFn activate = LoadActivate();
  if (!activate) {
    return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
  }

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      mode == LoopbackMode::IncludeTargetTree
          ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
          : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT prop = {};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ActivationHandler* handler = new ActivationHandler();
  if (!handler->ok()) {
    handler->Release();
    return HRESULT_FROM_WIN32(GetLastError());
  }

  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                        __uuidof(IAudioClient), &prop, handler, &op);
  if (SUCCEEDED(hr)) {
    const HANDLE waits[2] = {handler->done(), stop};
    const DWORD woke =
        WaitForMultipleObjects(2, waits, FALSE, kActivateTimeoutMs);
    if (woke == WAIT_OBJECT_0 + 1) {
      hr = E_ABORT;
    } else if (woke != WAIT_OBJECT_0) {
      hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    } else {
      HRESULT activated = E_UNEXPECTED;
      IUnknown* unknown = nullptr;
      hr = op->GetActivateResult(&activated, &unknown);
      if (SUCCEEDED(hr)) {
        hr = activated;
      }
      if (SUCCEEDED(hr)) {
        hr = unknown ? unknown->QueryInterface(__uuidof(IAudioClient),
                                               reinterpret_cast<void**>(out))
                     : E_NOINTERFACE;
      }
      if (unknown) {
        unknown->Release();
      }
    }
  }
  if (op) {
    op->Release();
  }
  handler->Release();
  return hr;
}

WAVEFORMATEX CaptureFormat() {
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = static_cast<WORD>(kChannels);
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(kChannels * sizeof(float));
  format.nAvgBytesPerSec = kSampleRate * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

// "Pro Audio" scheduling for the capture thread, the same class Chromium's
// own WASAPI threads ask for. Optional: a missing avrt.dll only costs
// priority, never the capture.
class MmcssScope {
 public:
  MmcssScope() {
    HMODULE avrt =
        LoadLibraryExW(L"avrt.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!avrt) {
      return;
    }
    using SetFn = HANDLE(WINAPI*)(LPCWSTR, LPDWORD);
    revert_ = reinterpret_cast<RevertFn>(reinterpret_cast<void*>(
        GetProcAddress(avrt, "AvRevertMmThreadCharacteristics")));
    const SetFn set = reinterpret_cast<SetFn>(reinterpret_cast<void*>(
        GetProcAddress(avrt, "AvSetMmThreadCharacteristicsW")));
    if (set && revert_) {
      DWORD index = 0;
      handle_ = set(L"Pro Audio", &index);
    }
  }
  ~MmcssScope() {
    if (handle_ && revert_) {
      revert_(handle_);
    }
  }
  MmcssScope(const MmcssScope&) = delete;
  MmcssScope& operator=(const MmcssScope&) = delete;

 private:
  using RevertFn = BOOL(WINAPI*)(HANDLE);
  HANDLE handle_ = nullptr;
  RevertFn revert_ = nullptr;
};

template <typename T>
void SafeRelease(T*& pointer) {
  if (pointer) {
    pointer->Release();
    pointer = nullptr;
  }
}

}  // namespace

LoopbackCapture::LoopbackCapture(DWORD pid, LoopbackMode mode, ChunkSink chunks,
                                 EventSink events)
    : pid_(pid),
      mode_(mode),
      chunks_(std::move(chunks)),
      events_(std::move(events)) {}

LoopbackCapture::~LoopbackCapture() {
  Stop();
  if (stop_) {
    CloseHandle(stop_);
  }
  if (sampleReady_) {
    CloseHandle(sampleReady_);
  }
}

bool LoopbackCapture::Start() {
  if (started_.exchange(true)) {
    return false;
  }
  stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  sampleReady_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!stop_ || !sampleReady_) {
    return false;
  }
  try {
    thread_ = std::thread([this] { Run(); });
  } catch (const std::system_error&) {
    return false;
  }
  return true;
}

void LoopbackCapture::Stop() {
  if (stop_) {
    SetEvent(stop_);
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

void LoopbackCapture::Fail(const char* stage, HRESULT hr) {
  CaptureEvent event;
  event.type = CaptureEvent::Type::Error;
  event.stage = stage;
  event.hr = hr;
  events_(event);
}

void LoopbackCapture::Flush(std::vector<float>& pending) {
  const size_t chunk = static_cast<size_t>(kChunkFrames) * kChannels;
  size_t offset = 0;
  while (pending.size() - offset >= chunk) {
    std::vector<float> out(pending.begin() + offset,
                           pending.begin() + offset + chunk);
    chunks_(std::move(out));
    offset += chunk;
  }
  if (offset > 0) {
    pending.erase(pending.begin(), pending.begin() + offset);
  }
}

void LoopbackCapture::Run() {
  CaptureEvent stats;
  stats.type = CaptureEvent::Type::Ended;
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com)) {
    Fail("com", com);
  } else {
    MmcssScope mmcss;
    RunCapture(stats);
    CoUninitialize();
  }
  events_(stats);
}

void LoopbackCapture::RunCapture(CaptureEvent& stats) {
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  const WAVEFORMATEX format = CaptureFormat();
  const DWORD baseFlags =
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;

  HRESULT hr = ActivateProcessLoopback(pid_, mode_, stop_, &client);
  if (FAILED(hr)) {
    Fail("activate", hr);
    return;
  }

  bool autoConvert = true;
  hr = client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      baseFlags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
          AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDuration, 0, &format, nullptr);
  if (hr == E_INVALIDARG || hr == AUDCLNT_E_UNSUPPORTED_FORMAT) {
    // Retry with exactly the sample's flags, on a fresh client: a client
    // whose Initialize failed is not documented as reusable.
    SafeRelease(client);
    autoConvert = false;
    hr = ActivateProcessLoopback(pid_, mode_, stop_, &client);
    if (FAILED(hr)) {
      Fail("activate", hr);
      return;
    }
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, baseFlags,
                            kBufferDuration, 0, &format, nullptr);
  }
  if (FAILED(hr)) {
    Fail("initialize", hr);
    SafeRelease(client);
    return;
  }

  UINT32 bufferFrames = 0;
  if (FAILED(client->GetBufferSize(&bufferFrames))) {
    bufferFrames = 0;
  }
  hr = client->GetService(__uuidof(IAudioCaptureClient),
                          reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    Fail("service", hr);
    SafeRelease(client);
    return;
  }
  hr = client->SetEventHandle(sampleReady_);
  if (FAILED(hr)) {
    Fail("event", hr);
    SafeRelease(capture);
    SafeRelease(client);
    return;
  }
  hr = client->Start();
  if (FAILED(hr)) {
    Fail("start", hr);
    SafeRelease(capture);
    SafeRelease(client);
    return;
  }

  CaptureEvent started;
  started.type = CaptureEvent::Type::Started;
  started.autoConvert = autoConvert;
  started.bufferFrames = bufferFrames;
  events_(started);
  stats.autoConvert = autoConvert;
  stats.bufferFrames = bufferFrames;

  std::vector<float> pending;
  pending.reserve(static_cast<size_t>(kChunkFrames) * kChannels * 8);
  const HANDLE waits[2] = {stop_, sampleReady_};
  for (;;) {
    const DWORD woke = WaitForMultipleObjects(2, waits, FALSE, kWaitMs);
    if (woke == WAIT_OBJECT_0) {
      break;
    }
    if (woke == WAIT_TIMEOUT) {
      continue;
    }
    if (woke != WAIT_OBJECT_0 + 1) {
      Fail("wait", HRESULT_FROM_WIN32(GetLastError()));
      break;
    }
    UINT32 packet = 0;
    while (SUCCEEDED(hr = capture->GetNextPacketSize(&packet)) && packet != 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr) || hr == AUDCLNT_S_BUFFER_EMPTY) {
        break;
      }
      stats.packets += 1;
      stats.frames += frames;
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
        stats.discontinuities += 1;
      }
      const size_t samples = static_cast<size_t>(frames) * kChannels;
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
        stats.silentPackets += 1;
        pending.insert(pending.end(), samples, 0.0f);
      } else {
        const float* pcm = reinterpret_cast<const float*>(data);
        pending.insert(pending.end(), pcm, pcm + samples);
      }
      hr = capture->ReleaseBuffer(frames);
      if (FAILED(hr)) {
        break;
      }
      Flush(pending);
    }
    if (FAILED(hr)) {
      // AUDCLNT_E_DEVICE_INVALIDATED lands here when the default output
      // changes mid-share. Reported, not retried: the renderer hears silence
      // and the share goes on, which is today's behaviour for a lost tap.
      Fail("read", hr);
      break;
    }
  }

  client->Stop();
  SafeRelease(capture);
  SafeRelease(client);
}

}  // namespace pqp
