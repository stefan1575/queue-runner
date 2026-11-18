; Added to electron-builder's NSIS script (electron-builder.json, nsis.include).
; Uninstalling removes the app's logon entry, which the app writes itself (src/platform/windows.ts,
; LOGON_ENTRY in src/platform/platform.ts). An update runs the old uninstaller first (isUpdated):
; the entry stays then, since the new app keeps it. The state folder (%APPDATA%\Queue runner) is
; kept: nsis.deleteAppDataOnUninstall is false.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Queue runner"
  ${endIf}
!macroend
