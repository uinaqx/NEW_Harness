param([Parameter(Mandatory=$true)][string]$TargetFile)
$ErrorActionPreference = 'Stop'
function Write-HookLog([string]$Message) {
    try { Add-Content -LiteralPath (Join-Path $env:TEMP 'harness-install-hook.log') -Value "$(Get-Date -Format o) $Message" -Encoding UTF8 } catch {}
}
function Wait-ExclusiveOpen([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        try {
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $stream.Dispose()
            Write-HookLog "unlocked: $Path"
            return
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for file to unlock: $Path ($($_.Exception.Message))" }
            Start-Sleep -Milliseconds 300
        }
    } while ($true)
}
try {
    # UTF-16 target file avoids ANSI corruption of Chinese installation paths.
    $installRoot = [IO.Path]::GetFullPath([IO.File]::ReadAllText($TargetFile, [Text.Encoding]::Unicode)).TrimEnd('\')
    $shellPath = Join-Path $installRoot 'harness-shell.exe'
    Write-HookLog "target: $installRoot"
    $processes = @(Get-CimInstance Win32_Process)
    $roots = @($processes | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $shellPath, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($rootProcess in $roots) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($rootProcess.ProcessId)"
        if ($current -and [string]::Equals($current.ExecutablePath, $shellPath, [StringComparison]::OrdinalIgnoreCase)) {
            Write-HookLog "stopping shell PID $($rootProcess.ProcessId)"
            & "$env:SystemRoot\System32\taskkill.exe" /PID $rootProcess.ProcessId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $rootProcess.ProcessId -ErrorAction SilentlyContinue)) { throw 'Failed to stop target installation' }
        }
    }
    Wait-ExclusiveOpen $shellPath
    Wait-ExclusiveOpen (Join-Path $installRoot 'opencode\opencode.exe')
    Write-HookLog 'target installation ready for replacement'
    exit 0
} catch {
    Write-HookLog "error: $($_.Exception.Message)"
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
