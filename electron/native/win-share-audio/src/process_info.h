// What the shell needs to know about other processes to aim a window share's
// audio at the right one. Only facts here; the decisions (which process is
// "the app", when including it would put the call back in the share) are in
// `electron/lib/win-share-audio.js`, where they can be tested without Windows.
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace pqp {

struct ProcessEntry {
  DWORD pid = 0;
  DWORD parentPid = 0;
  std::string exe;  // UTF-8 basename, as Toolhelp reports it
};

struct WindowOwner {
  DWORD pid = 0;
  // Processes that own a child window of this one, other than `pid`. A UWP
  // app's top-level window belongs to ApplicationFrameHost.exe and the app
  // itself owns the CoreWindow inside it; this is how the JS side finds it.
  std::vector<DWORD> childPids;
};

std::vector<ProcessEntry> ListProcesses();
bool OwnerOfWindow(HWND hwnd, WindowOwner* out);
// 100 ns ticks since 1601, or false when the process is gone or protected.
bool ProcessCreationTime(DWORD pid, uint64_t* out);

}  // namespace pqp
