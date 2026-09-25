$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('harness-installer-test-' + [guid]::NewGuid())
$target = Join-Path $scratch '中文 installation'
$other = Join-Path $scratch 'unrelated'
New-Item -ItemType Directory -Path $target,$other | Out-Null
$hook = Join-Path $project 'shell\src-tauri\nsis\installer-hooks.nsh'
$probe = Join-Path $scratch 'probe.exe'
$source = Join-Path $scratch 'probe.nsi'
$script = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include "@HOOK@"
OutFile "@PROBE@"
Section
  StrCpy $INSTDIR "@TARGET@"
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $3 "$INSTDIR\passed" w
  FileWrite $3 "ok"
  FileClose $3
SectionEnd
'@
$script = $script.Replace('@HOOK@',$hook).Replace('@PROBE@',$probe).Replace('@TARGET@',$target)
[IO.File]::WriteAllText($source,$script,[Text.UTF8Encoding]::new($true))
& (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe') /V2 $source
if ($LASTEXITCODE -ne 0) { throw 'NSIS probe compilation failed' }
$marker = Join-Path $target 'passed'
function Run-Probe([bool]$expected, [string]$label) {
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
    $p = Start-Process -FilePath $probe -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(30000)) { Stop-Process -Id $p.Id; throw "Timed out: $label" }
    $success = Test-Path -LiteralPath $marker
    if ($success -ne $expected) { throw "FAIL $label (exit=$($p.ExitCode))" }
    "PASS $label (exit=$($p.ExitCode))"
}
Run-Probe $true 'first install: absent payload'
[IO.File]::WriteAllBytes((Join-Path $target 'harness-shell.exe'),[byte[]](1,2,3))
New-Item -ItemType Directory -Path (Join-Path $target 'opencode') | Out-Null
[IO.File]::WriteAllBytes((Join-Path $target 'opencode\opencode.exe'),[byte[]](1,2,3))
Run-Probe $true 'existing unlocked files'
$handle = [IO.File]::Open((Join-Path $target 'harness-shell.exe'),'Open','ReadWrite','None')
try { Run-Probe $false 'locked shell aborts' } finally { $handle.Dispose() }
$handle = [IO.File]::Open((Join-Path $target 'opencode\opencode.exe'),'Open','ReadWrite','None')
try { Run-Probe $false 'locked engine aborts' } finally { $handle.Dispose() }
Copy-Item -LiteralPath "$env:SystemRoot\System32\ping.exe" -Destination (Join-Path $target 'harness-shell.exe') -Force
Copy-Item -LiteralPath "$env:SystemRoot\System32\ping.exe" -Destination (Join-Path $other 'harness-shell.exe')
$own = Start-Process -FilePath (Join-Path $target 'harness-shell.exe') -ArgumentList '-t','127.0.0.1' -PassThru -WindowStyle Hidden
$unrelated = Start-Process -FilePath (Join-Path $other 'harness-shell.exe') -ArgumentList '-t','127.0.0.1' -PassThru -WindowStyle Hidden
try {
    Run-Probe $true 'running target process is stopped'
    if (-not $own.WaitForExit(5000)) { throw 'Target survived' }
    if ($unrelated.HasExited) { throw 'Unrelated installation was killed' }
    'PASS same-name process from another installation preserved'
} finally {
    foreach ($p in @($own,$unrelated)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id } }
}
"Evidence directory: $scratch"
