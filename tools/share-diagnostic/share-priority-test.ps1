<#
.SYNOPSIS
  Experiment for the high-refresh game share lag (2026-09-30): raise the GPU or
  CPU scheduling priority of the browser (or the pqp desktop app) and see
  whether a share of an uncapped game stops lagging.

.DESCRIPTION
  A screen share has to copy every captured frame on the graphics card, and
  its encoder may use the graphics card too. A game running uncapped keeps the
  card busy all the time, and Windows favours the game. If that is why the
  share lags, giving the sharing app a higher GPU scheduling priority fixes it
  with the game still uncapped. That is exactly what OBS does when it runs as
  administrator, and what Sunshine does for game streaming.

  Nothing here is permanent. Priorities go back to normal when the app is
  closed, or with -Mode reset.

  Steps:
    1. Start the share the way that lags (game uncapped, pqp in Chrome or the
       desktop app). Confirm it lags.
    2. In a normal PowerShell window:
         powershell -ExecutionPolicy Bypass -File share-priority-test.ps1 -Target chrome -Mode status
       then
         powershell -ExecutionPolicy Bypass -File share-priority-test.ps1 -Target chrome -Mode gpu
       The output says whether Windows allowed it without administrator
       rights. If it says "needs administrator", open PowerShell with "Run as
       administrator" and run the gpu command again.
    3. Watch the share for a minute with the game uncapped. Better or not?
    4. -Mode reset, then try -Mode cpu (CPU priority only) and watch again.
       GPU fixes it and CPU does not: the graphics card is the bottleneck.
       CPU fixes it: the processor is.

.PARAMETER Target
  chrome, msedge or pqp (the desktop app).

.PARAMETER Mode
  status: show priorities, hardware GPU scheduling and Game Mode.
  gpu:    raise the GPU scheduling priority class.
  cpu:    raise the CPU priority class (browser and GPU process only).
  both:   gpu and cpu.
  reset:  put both back to normal.

.PARAMETER GpuClass
  High (default) or Realtime. Realtime can freeze NVIDIA drivers when hardware
  GPU scheduling is on (Sunshine's notes), so High is the one to try first.
#>
param(
  [ValidateSet('chrome', 'msedge', 'pqp')][string]$Target = 'chrome',
  [ValidateSet('status', 'gpu', 'cpu', 'both', 'reset')][string]$Mode = 'status',
  [ValidateSet('High', 'Realtime')][string]$GpuClass = 'High'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PqpGpuPriority {
  [DllImport("gdi32.dll")]
  public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);
  [DllImport("gdi32.dll")]
  public static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr process, out int priority);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

# D3DKMT_SCHEDULINGPRIORITYCLASS
$classNames = @('Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'Realtime')
$PROCESS_SET_INFORMATION = 0x0200
$PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

function Get-GpuClass([int]$procId) {
  $h = [PqpGpuPriority]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $procId)
  if ($h -eq [IntPtr]::Zero) { return 'no access' }
  try {
    $p = 0
    $status = [PqpGpuPriority]::D3DKMTGetProcessSchedulingPriorityClass($h, [ref]$p)
    if ($status -ne 0) { return ('error 0x{0:X8}' -f $status) }
    return $classNames[$p]
  } finally { [void][PqpGpuPriority]::CloseHandle($h) }
}

function Set-GpuClass([int]$procId, [int]$class) {
  $h = [PqpGpuPriority]::OpenProcess($PROCESS_SET_INFORMATION -bor $PROCESS_QUERY_LIMITED_INFORMATION, $false, $procId)
  if ($h -eq [IntPtr]::Zero) { return 'no access to the process' }
  try {
    $status = [PqpGpuPriority]::D3DKMTSetProcessSchedulingPriorityClass($h, $class)
    if ($status -eq 0) { return 'ok' }
    # STATUS_PRIVILEGE_NOT_HELD
    if (($status -band 0xFFFFFFFF) -eq 0xC0000061) { return 'needs administrator (STATUS_PRIVILEGE_NOT_HELD)' }
    return ('refused, NTSTATUS 0x{0:X8}' -f $status)
  } finally { [void][PqpGpuPriority]::CloseHandle($h) }
}

function Get-Role([string]$commandLine) {
  if ($commandLine -match '--type=gpu-process') { return 'gpu' }
  if ($commandLine -match '--type=renderer') { return 'renderer' }
  if ($commandLine -match '--type=utility') { return 'utility' }
  if ($commandLine -match '--type=([a-z-]+)') { return $Matches[1] }
  return 'browser'
}

$procs = Get-CimInstance Win32_Process -Filter "Name='$Target.exe'" |
  ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Role = (Get-Role $_.CommandLine) } }
if (-not $procs) { Write-Host "No $Target.exe is running. Start it and the share first."; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hags = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
$gameMode = (Get-ItemProperty 'HKCU:\Software\Microsoft\GameBar' -Name AutoGameModeEnabled -ErrorAction SilentlyContinue).AutoGameModeEnabled
$gpus = (Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ', '

Write-Host ("Administrator: {0}" -f $isAdmin)
Write-Host ("GPU: {0}" -f $gpus)
Write-Host ("Hardware-accelerated GPU scheduling: {0}" -f $(if ($hags -eq 2) { 'on' } elseif ($hags -eq 1) { 'off' } else { 'unknown (default)' }))
Write-Host ("Game Mode: {0}" -f $(if ($gameMode -eq 0) { 'off' } else { 'on (default)' }))
Write-Host ''

$gpuTarget = if ($GpuClass -eq 'Realtime') { 5 } else { 4 }
foreach ($p in $procs) {
  $actions = @()
  if ($Mode -in @('gpu', 'both')) { $actions += ('gpu ' + (Set-GpuClass $p.Id $gpuTarget)) }
  if ($Mode -eq 'reset') { $actions += ('gpu ' + (Set-GpuClass $p.Id 2)) }
  if ($Mode -in @('cpu', 'both', 'reset') -and $p.Role -in @('browser', 'gpu')) {
    try {
      $sp = [System.Diagnostics.Process]::GetProcessById($p.Id)
      $sp.PriorityClass = $(if ($Mode -eq 'reset') { 'Normal' } else { 'High' })
      $actions += 'cpu ok'
    } catch { $actions += ('cpu refused: ' + $_.Exception.Message) }
  }
  $cpuNow = try { [System.Diagnostics.Process]::GetProcessById($p.Id).PriorityClass } catch { '?' }
  Write-Host ('{0,-9} pid {1,-6} cpu {2,-12} gpu {3,-12} {4}' -f $p.Role, $p.Id, $cpuNow, (Get-GpuClass $p.Id), ($actions -join ', '))
}
