; Close any running kstream before overwrite. Old portable / in-app installs
; leave kstream.exe locked, which makes a one-click setup look like a no-op.
!macro customInit
  nsExec::Exec 'taskkill /F /IM kstream.exe /T'
  Sleep 800
  ; Custom in-app installer used this ARP key; NSIS uses the appId key.
  nsExec::Exec 'reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\kstream" /f'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM kstream.exe /T'
  Sleep 400
!macroend
