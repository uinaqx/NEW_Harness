; Stop only the target installation, then check existing payloads exclusively.
!define HARNESS_STOP_SCRIPT "${__FILEDIR__}\stop-installation.ps1"
!macro HARNESS_STOP_APP
  InitPluginsDir
  File /oname=$PLUGINSDIR\harness-stop.ps1 "${HARNESS_STOP_SCRIPT}"
  FileOpen $1 "$PLUGINSDIR\harness-target.txt" w
  FileWriteUTF16LE $1 "$INSTDIR"
  FileClose $1
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\harness-stop.ps1" -TargetFile "$PLUGINSDIR\harness-target.txt"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not stop this Harness installation. Close it and retry." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro HARNESS_CHECK_FILE path
  ${If} ${FileExists} "${path}"
    ; GENERIC_WRITE, share mode 0, OPEN_EXISTING: no creation or truncation.
    System::Call 'kernel32::CreateFileW(w "${path}", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
    ${If} $0 == -1
      MessageBox MB_OK|MB_ICONSTOP "A Harness file is still locked or not writable. Installation stopped. Close Harness and retry.$\r$\n${path}" /SD IDOK
      Abort
    ${Else}
      System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro HARNESS_STOP_APP
  !insertmacro HARNESS_CHECK_FILE "$INSTDIR\harness-shell.exe"
  !insertmacro HARNESS_CHECK_FILE "$INSTDIR\opencode\opencode.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HARNESS_STOP_APP
!macroend
