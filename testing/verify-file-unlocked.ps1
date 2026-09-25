param([Parameter(Mandatory=$true)][string]$Path)
try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Dispose()
    exit 0
} catch { exit 1 }
