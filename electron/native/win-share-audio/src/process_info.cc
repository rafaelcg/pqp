#include "process_info.h"

#include <tlhelp32.h>

#include <algorithm>

namespace pqp {
namespace {

std::string Utf8(const wchar_t* wide) {
  if (!wide || !*wide) {
    return std::string();
  }
  const int size =
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) {
    return std::string();
  }
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, &out[0], size, nullptr, nullptr);
  return out;
}

struct ChildSearch {
  DWORD owner;
  std::vector<DWORD>* found;
};

BOOL CALLBACK CollectChildOwner(HWND child, LPARAM param) {
  ChildSearch* search = reinterpret_cast<ChildSearch*>(param);
  DWORD pid = 0;
  GetWindowThreadProcessId(child, &pid);
  if (pid != 0 && pid != search->owner &&
      std::find(search->found->begin(), search->found->end(), pid) ==
          search->found->end()) {
    search->found->push_back(pid);
  }
  // A window can have hundreds of children; a handful of distinct owners is
  // already more than any real case has.
  return search->found->size() < 8 ? TRUE : FALSE;
}

}  // namespace

std::vector<ProcessEntry> ListProcesses() {
  std::vector<ProcessEntry> out;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return out;
  }
  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      ProcessEntry process;
      process.pid = entry.th32ProcessID;
      process.parentPid = entry.th32ParentProcessID;
      process.exe = Utf8(entry.szExeFile);
      out.push_back(std::move(process));
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return out;
}

bool OwnerOfWindow(HWND hwnd, WindowOwner* out) {
  if (!hwnd || !IsWindow(hwnd)) {
    return false;
  }
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) {
    return false;
  }
  out->pid = pid;
  out->childPids.clear();
  ChildSearch search{pid, &out->childPids};
  EnumChildWindows(hwnd, CollectChildOwner, reinterpret_cast<LPARAM>(&search));
  return true;
}

bool ProcessCreationTime(DWORD pid, uint64_t* out) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    return false;
  }
  FILETIME created = {};
  FILETIME exited = {};
  FILETIME kernel = {};
  FILETIME user = {};
  const BOOL ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
  CloseHandle(process);
  if (!ok) {
    return false;
  }
  *out = (static_cast<uint64_t>(created.dwHighDateTime) << 32) |
         created.dwLowDateTime;
  return true;
}

}  // namespace pqp
