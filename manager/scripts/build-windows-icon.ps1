[CmdletBinding()]
param(
    [string]$SourcePath = "",
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$managerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $managerRoot "web\assets\brand\OsisLogo-Cloudig-1024.png"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $managerRoot "windows\Cloudig.Desktop\Assets\Cloudig-Taskbar.ico"
}
$SourcePath = [IO.Path]::GetFullPath($SourcePath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "Cloudig taskbar icon source is missing: $SourcePath"
}
if (-not $OutputPath.StartsWith($managerRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Cloudig taskbar icon output escaped the Manager directory: $OutputPath"
}

Add-Type -AssemblyName System.Drawing

$IconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$InsetRatio = 0.0625
$CornerRadiusRatio = 0.20

function New-RoundedRectanglePath(
    [System.Drawing.RectangleF]$Rectangle,
    [single]$Radius
) {
    $diameter = [single]($Radius * 2)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-TaskbarPng(
    [System.Drawing.Image]$Source,
    [int]$Size
) {
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object IO.MemoryStream
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

        $inset = [Math]::Max(1, [int][Math]::Round($Size * $InsetRatio))
        $visualSize = $Size - ($inset * 2)
        $rectangle = New-Object System.Drawing.RectangleF(
            [single]$inset,
            [single]$inset,
            [single]$visualSize,
            [single]$visualSize
        )
        $radius = [single][Math]::Max(2, $visualSize * $CornerRadiusRatio)
        $path = New-RoundedRectanglePath -Rectangle $rectangle -Radius $radius
        try {
            $graphics.SetClip($path)
            $graphics.DrawImage($Source, $rectangle)
            $graphics.ResetClip()
        }
        finally {
            $path.Dispose()
        }

        if ($bitmap.GetPixel(0, 0).A -ne 0 -or
            $bitmap.GetPixel($Size - 1, [int]($Size / 2)).A -ne 0 -or
            $bitmap.GetPixel([int]($Size / 2), [int]($Size / 2)).A -lt 250) {
            throw "Cloudig taskbar icon alpha geometry failed at ${Size}px."
        }

        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return [pscustomobject]@{
            Size = $Size
            Bytes = $stream.ToArray()
        }
    }
    finally {
        $stream.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$source = [System.Drawing.Image]::FromFile($SourcePath)
$entries = @()
$iconStream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($iconStream)
try {
    if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
        throw "Cloudig taskbar icon source must be a square image of at least 256 px."
    }

    foreach ($size in $IconSizes) {
        $entries += New-TaskbarPng -Source $source -Size $size
    }

    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$entries.Count)
    $offset = 6 + (16 * $entries.Count)
    foreach ($entry in $entries) {
        $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$entry.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $entry.Bytes.Length
    }
    foreach ($entry in $entries) {
        $writer.Write([byte[]]$entry.Bytes)
    }
    $writer.Flush()

    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    [IO.File]::WriteAllBytes($OutputPath, $iconStream.ToArray())
}
finally {
    $writer.Dispose()
    $iconStream.Dispose()
    $source.Dispose()
}

$hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{
    output = $OutputPath
    sizes = $IconSizes -join ","
    inset_ratio = $InsetRatio
    corner_radius_ratio = $CornerRadiusRatio
    bytes = (Get-Item -LiteralPath $OutputPath).Length
    sha256 = $hash
}
