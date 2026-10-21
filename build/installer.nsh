; Never terminate processes by executable name. Other portable/check-out copies
; can be doing unrelated work under the same Windows account.
!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "COMMANDER_INSTALL_DIRECTORY", t "$INSTDIR")'
  StrCpy $PowerShellPath "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$PowerShellPath" +2 0
    StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

  ; The path is data in an environment variable, never interpolated into code.
  ; 10: this install is running; 11: unsafe older uninstaller; 12: cannot inspect.
  nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -Command "try { $$ErrorActionPreference = 'Stop'; $$root = [IO.Path]::GetFullPath($$env:COMMANDER_INSTALL_DIRECTORY).TrimEnd('\') + '\'; $$copies = @(Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @('${APP_EXECUTABLE_FILENAME}', 'service-bus-commander.exe') }); if (@($$copies | Where-Object { -not $$_.ExecutablePath }).Count) { exit 12 }; if (@($$copies | Where-Object { $$_.ExecutablePath.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) }).Count) { exit 10 }; $$old = Join-Path $$root 'Uninstall service-bus-commander.exe'; if ((Test-Path -LiteralPath $$old) -and $$copies.Count) { $$legacy = $$true; try { $$legacy = [version](Get-Item -LiteralPath $$old).VersionInfo.FileVersion -lt [version]'0.62.1' } catch {}; if ($$legacy) { exit 11 } }; exit 0 } catch { exit 12 }"`
  Pop $R0
  Pop $R1
  System::Call 'kernel32::SetEnvironmentVariable(t "COMMANDER_INSTALL_DIRECTORY", p 0)'

  ${If} $R0 == 10
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Msg Commander in this installation, then run setup again." /SD IDOK
  ${ElseIf} $R0 == 11
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close other Msg Commander copies before upgrading this older installation. Its previous uninstaller can close unrelated copies." /SD IDOK
  ${ElseIf} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Setup could not check running app copies. No processes were closed. Close the app and try setup again." /SD IDOK
  ${EndIf}
  ${If} $R0 != 0
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
