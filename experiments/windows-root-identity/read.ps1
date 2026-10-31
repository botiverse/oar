param(
  [Parameter(Mandatory = $true)][string]$ProcessIds,
  [switch]$InjectCimFailure
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targets = @($ProcessIds.Split(',') | ForEach-Object { [int]$_ })
$watch = [Diagnostics.Stopwatch]::StartNew()
# These are read-only process queries. Every helper handle is closed before return.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdentityRead {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public sealed class Result {
    public int pid; public bool ok; public int error; public string stage;
    public string creationFileTime; public string exitFileTime; public uint exitCode;
    public bool handleClosed; public int closeError;
  }
  static string Ticks(FileTime value) { return (((ulong)value.High << 32) | value.Low).ToString(); }
  public static Result Read(int pid) {
    var result = new Result { pid=pid, stage="OpenProcess" };
    var handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) { result.error=Marshal.GetLastWin32Error(); return result; }
    try {
      FileTime creation, exit, kernel, user; uint code;
      result.stage="GetProcessTimes";
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) { result.error=Marshal.GetLastWin32Error(); return result; }
      result.creationFileTime=Ticks(creation); result.exitFileTime=Ticks(exit);
      result.stage="GetExitCodeProcess";
      if (!GetExitCodeProcess(handle, out code)) { result.error=Marshal.GetLastWin32Error(); return result; }
      result.exitCode=code; result.ok=true; result.stage="complete";
      return result;
    } finally {
      result.handleClosed=CloseHandle(handle);
      if (!result.handleClosed) { result.closeError=Marshal.GetLastWin32Error(); }
    }
  }
}
'@
$native = @($targets | ForEach-Object { [IdentityRead]::Read($_) })
$nativeMs = $watch.Elapsed.TotalMilliseconds
$cimStart = [DateTime]::UtcNow.ToString('o')
$cim = $null
try {
  if ($InjectCimFailure) { throw 'Deliberately injected CIM reader failure; no operating-system failure claimed.' }
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
  $rows = @($all | Where-Object { $targets -contains [int]$_.ProcessId -or $targets -contains [int]$_.ParentProcessId } | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      creationFileTime = $(if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() })
      creationUtc = $(if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') })
    }
  })
  $cim = @{ ok=$true; observedCount=$all.Count; rows=$rows }
} catch {
  $cim = @{ ok=$false; error=$_.Exception.Message; injected=[bool]$InjectCimFailure }
}
$self = [Diagnostics.Process]::GetCurrentProcess()
@{
  native=$native; cim=$cim; readerPid=$PID; nativeMs=$nativeMs
  cimStartedUtc=$cimStart; cimFinishedUtc=[DateTime]::UtcNow.ToString('o')
  totalMs=$watch.Elapsed.TotalMilliseconds
  observerWorkingSetBytes=$self.WorkingSet64; observerHandleCount=$self.HandleCount
  observerCpuMs=$self.TotalProcessorTime.TotalMilliseconds
} | ConvertTo-Json -Depth 8 -Compress
