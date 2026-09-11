; First-run Setup: quit old kstream, delete leftover app files, then install fresh.
; In-app updates still pass /S and go through this same cleanup.
!macro customInit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${BUILD_RESOURCES_DIR}/clean-old-kstream.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\clean-old-kstream.ps1"'
  Sleep 400
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM kstream.exe /T'
  Sleep 400
!macroend
