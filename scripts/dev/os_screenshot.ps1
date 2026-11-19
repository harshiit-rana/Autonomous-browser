param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Out = '',
  [string]$SetSize = '',   # "WIDTHxHEIGHT" in device-independent pixels, e.g. 1000x700
  [switch]$PrintWindow,   # capture with PrintWindow(PW_RENDERFULLCONTENT) instead of copying the screen (works when other windows cover it)
  [switch]$Children       # print every descendant HWND (class, visible, screen rect): the real native-view geometry
)
# Captures what is really painted on screen for the top-level window of an Electron main process,
# and can resize that window with the Win32 API.
# CDP screenshots (Page.captureScreenshot) only see one renderer's own surface, never the native
# WebContentsView children composited on top of it; this is the only way to see the real window.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Runtime.InteropServices;
public static class Win32Shot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool OpenIcon(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
  public static string ZOrder(int n) {
    var o = new System.Text.StringBuilder(); int k = 0;
    for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero && k < n; h = GetWindow(h, 2)) {
      if (!IsWindowVisible(h)) continue;
      var c = new System.Text.StringBuilder(40); GetClassName(h, c, 40);
      var t = new System.Text.StringBuilder(30); GetWindowText(h, t, 30);
      uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
      o.Append(k + ":" + pid + ":" + c + ":[" + t + "]:top=" + ((GetWindowLong(h, -20) & 8) != 0) + ":" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T) + " | "); k++;
    }
    return o.ToString();
  }
  public static uint PidAt(int x, int y) { POINT p; p.X = x; p.Y = y; IntPtr w = WindowFromPoint(p); if (w == IntPtr.Zero) return 0; IntPtr root = GetAncestor(w, 2); uint pid; GetWindowThreadProcessId(root == IntPtr.Zero ? w : root, out pid); return pid; }
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
  public static string Children(IntPtr top) {
    var parts = new System.Collections.Generic.List<string>();
    EnumChildWindows(top, (h, l) => {
      var sb = new System.Text.StringBuilder(256); GetClassName(h, sb, 256);
      RECT r; GetWindowRect(h, out r);
      parts.Add("{\"class\":\"" + sb.ToString() + "\",\"visible\":" + (IsWindowVisible(h) ? "true" : "false") + ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", parts) + "]";
  }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr FindTopLevel(uint pid) {
    IntPtr found = IntPtr.Zero; long best = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        long area = (long)(r.R - r.L) * (r.B - r.T);
        if (area > best) { best = area; found = h; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[Win32Shot]::SetProcessDPIAware() | Out-Null
$h = [Win32Shot]::FindTopLevel([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { throw "no visible top-level window for pid $ProcessId" }
function Invoke-Front {
  [Win32Shot]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  for ($i = 0; $i -lt 6 -and [Win32Shot]::IsIconic($h); $i++) {   # a minimized window can ignore the first restore
    [Win32Shot]::OpenIcon($h) | Out-Null
    [Win32Shot]::SendMessage($h, 0x112, [IntPtr]0xF120, [IntPtr]::Zero) | Out-Null   # WM_SYSCOMMAND, SC_RESTORE
    Start-Sleep -Milliseconds 400
  }
  # Windows' foreground lock refuses SetForegroundWindow from a background process; a synthetic ALT key press lifts it.
  [Win32Shot]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Win32Shot]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [Win32Shot]::SetForegroundWindow($h) | Out-Null
  [Win32Shot]::BringWindowToTop($h) | Out-Null
}
Invoke-Front
if ($Children) {
  $rt = New-Object Win32Shot+RECT
  [Win32Shot]::GetWindowRect($h, [ref]$rt) | Out-Null
  Write-Output ("top={0},{1},{2},{3} dpi={4}" -f $rt.L, $rt.T, ($rt.R - $rt.L), ($rt.B - $rt.T), [Win32Shot]::GetDpiForWindow($h))
  Write-Output ("children=" + [Win32Shot]::Children($h))
  exit 0
}
$dpi = [Win32Shot]::GetDpiForWindow($h)
if ($SetSize -ne '') {
  $parts = $SetSize.Split('x')
  $w = [int]([int]$parts[0] * $dpi / 96); $hh = [int]([int]$parts[1] * $dpi / 96)
  $r0 = New-Object Win32Shot+RECT
  [Win32Shot]::GetWindowRect($h, [ref]$r0) | Out-Null
  # SWP_NOZORDER (0x4) | SWP_NOACTIVATE (0x10)
  [Win32Shot]::SetWindowPos($h, [IntPtr]::Zero, $r0.L, $r0.T, $w, $hh, 0x14) | Out-Null
  Start-Sleep -Milliseconds 600
}
if ($Out -ne '') {
# Windows' foreground lock can refuse SetForegroundWindow; a topmost window is on top of everything else for the capture.
[Win32Shot]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x13) | Out-Null   # HWND_TOPMOST, NOMOVE|NOSIZE|NOACTIVATE
  Start-Sleep -Milliseconds 1200   # a window that was covered stops painting (occlusion); give it time to repaint
  # Refuse to save a picture that contains another application: sample a grid of points and require that every one belongs to this
  # process. The window can be re-minimized or covered while we wait, so bring it to the front again and re-check a few times.
  for ($try = 1; $try -le 6; $try++) {
    $r = New-Object Win32Shot+RECT
    [Win32Shot]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $ht = $r.B - $r.T
    $foreign = @()
    foreach ($fx in 0.1, 0.35, 0.5, 0.65, 0.9) { foreach ($fy in 0.1, 0.35, 0.5, 0.65, 0.9) {
      $owner = [Win32Shot]::PidAt([int]($r.L + $w * $fx), [int]($r.T + $ht * $fy))
      if ($owner -ne [uint32]$ProcessId) { $foreign += $owner }
    } }
    if ($foreign.Count -eq 0 -and $w -ge 600 -and $ht -ge 400 -and -not [Win32Shot]::IsIconic($h)) { break }
    Invoke-Front
    [Win32Shot]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x13) | Out-Null
    Start-Sleep -Milliseconds 900
  }
  if (-not $PrintWindow -and ($foreign.Count -gt 0 -or $w -lt 600 -or $ht -lt 400)) {
    Write-Output ("occluded rect={0},{1},{2},{3} foreignSamples={4} owners={5} z=[{6}]" -f $r.L, $r.T, $w, $ht, $foreign.Count, (($foreign | Sort-Object -Unique) -join ','), [Win32Shot]::ZOrder(7))
    exit 3
  }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($PrintWindow) {
    $hdc = $g.GetHdc(); [Win32Shot]::PrintWindow($h, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc)
  } else {
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  }
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
# (the window is deliberately left topmost: switching it back to NOTOPMOST made Windows minimize it a moment later)
$r = New-Object Win32Shot+RECT
[Win32Shot]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("rect={0},{1},{2},{3} dpi={4} iconic={5} foreground={6}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), $dpi, [Win32Shot]::IsIconic($h), ([Win32Shot]::GetForegroundWindow() -eq $h))
