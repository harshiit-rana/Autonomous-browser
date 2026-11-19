param(
  [Parameter(Mandatory = $true)][int]$X,          # screen X in physical pixels
  [Parameter(Mandatory = $true)][int]$Y,          # screen Y in physical pixels
  [Parameter(Mandatory = $true)][int]$ExpectPid,  # refuse to click unless the top-level window under the point belongs to this process
  [switch]$HitTestOnly,                           # only report what is under the point, do not click
  [string]$Key = ''                               # optional: send this virtual key (e.g. 0x1B for Escape) instead of a click
)
# Real OS input for the design spikes (#232/#233/#237): CDP Input.* and webContents.sendInputEvent bypass native hit-testing, so they cannot
# tell whether a native overlay view swallows a user's click. This does SetCursorPos + mouse_event, then restores the cursor.
# Safety: it clicks only when the window under (X,Y) belongs to -ExpectPid; otherwise it exits 3 without clicking.
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OsInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  public static string Describe(int x, int y, out uint pid, out uint rootPid) {
    POINT p; p.X = x; p.Y = y; IntPtr w = WindowFromPoint(p);
    pid = 0; rootPid = 0; if (w == IntPtr.Zero) return "none";
    GetWindowThreadProcessId(w, out pid);
    IntPtr root = GetAncestor(w, 2); if (root == IntPtr.Zero) root = w; GetWindowThreadProcessId(root, out rootPid);
    var c = new StringBuilder(128); GetClassName(w, c, 128);
    var rc = new StringBuilder(128); GetClassName(root, rc, 128);
    return c.ToString() + " (root " + rc.ToString() + ")";
  }
}
"@
[OsInput]::SetProcessDPIAware() | Out-Null
$pid1 = [uint32]0; $root1 = [uint32]0
$desc = [OsInput]::Describe($X, $Y, [ref]$pid1, [ref]$root1)
if ($HitTestOnly) { Write-Output ("hit={0} pid={1} rootpid={2} clicked=false" -f $desc, $pid1, $root1); exit 0 }
if ($root1 -ne [uint32]$ExpectPid) { Write-Output ("refused hit={0} pid={1} rootpid={2} clicked=false" -f $desc, $pid1, $root1); exit 3 }
$old = New-Object OsInput+POINT
[OsInput]::GetCursorPos([ref]$old) | Out-Null
if ($Key -ne '') {
  [OsInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 80
  $vk = [Convert]::ToByte($Key, 16)
  [OsInput]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [OsInput]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
} else {
  [OsInput]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 120
  [OsInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 40
  [OsInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
}
Start-Sleep -Milliseconds 150
[OsInput]::SetCursorPos($old.X, $old.Y) | Out-Null
Write-Output ("hit={0} pid={1} rootpid={2} clicked=true" -f $desc, $pid1, $root1)
