param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Target,[Parameter(Mandatory=$true)][ValidateSet('07-branches','14-entry')][string]$Region)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$targetPath = [System.IO.Path]::GetFullPath($Target)
$assetRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/ui/shell/pages/document/assets/function-guide'))
if (-not $targetPath.StartsWith($assetRoot + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Crop output must stay in the feature-guide asset directory' }
$bitmap = [System.Drawing.Bitmap]::new($sourcePath)
try {
    # Fixed capture recipes after visual inspection of the 1920-DIP native frame.
    # Trim only unrelated neighbouring rows/empty rail, never redraw pixels.
    if ($Region -eq '07-branches') {
        if ($bitmap.Width -ne 1315 -or $bitmap.Height -ne 146) { throw 'Branch capture geometry changed; inspect before recropping' }
        $rectangle = [System.Drawing.Rectangle]::new(1085,10,220,70)
    } else {
        if ($bitmap.Height -lt 100 -or $bitmap.Width -gt 500) { throw 'Identity entry capture geometry changed' }
        $rectangle = [System.Drawing.Rectangle]::new(0,0,$bitmap.Width,90)
    }
    $crop = $bitmap.Clone($rectangle,$bitmap.PixelFormat)
    try { $crop.Save($targetPath,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose() }
    @{x=$rectangle.X;y=$rectangle.Y;width=$rectangle.Width;height=$rectangle.Height} | ConvertTo-Json -Compress
} finally { $bitmap.Dispose() }
