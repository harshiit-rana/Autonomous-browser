param(
  [Parameter(Mandatory = $true)][string]$PathA,
  [Parameter(Mandatory = $true)][string]$PathB,
  [Parameter(Mandatory = $true)][string]$Region,   # "x,y,w,h" in physical pixels
  [int]$Threshold = 40
)
# Counts pixels in a region whose colour differs by more than $Threshold (sum of |dR|+|dG|+|dB|) between two PNGs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$p = $Region.Split(',') | ForEach-Object { [int]$_ }
$bmpA = New-Object System.Drawing.Bitmap $PathA
$bmpB = New-Object System.Drawing.Bitmap $PathB
$changed = 0; $total = 0
$x1 = [Math]::Min($p[0] + $p[2], [Math]::Min($bmpA.Width, $bmpB.Width)); $y1 = [Math]::Min($p[1] + $p[3], [Math]::Min($bmpA.Height, $bmpB.Height))
for ($y = [Math]::Max(0, $p[1]); $y -lt $y1; $y++) {
  for ($x = [Math]::Max(0, $p[0]); $x -lt $x1; $x++) {
    $ca = $bmpA.GetPixel($x, $y); $cb = $bmpB.GetPixel($x, $y)
    $d = [Math]::Abs($ca.R - $cb.R) + [Math]::Abs($ca.G - $cb.G) + [Math]::Abs($ca.B - $cb.B)
    $total++
    if ($d -gt $Threshold) { $changed++ }
  }
}
$bmpA.Dispose(); $bmpB.Dispose()
Write-Output ("changed={0} total={1}" -f $changed, $total)
