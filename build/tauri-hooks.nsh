; Captura installer hooks (Tauri NSIS, per-user, HKCU).
; Adds Captura to Explorer's "Open with" list for image types WITHOUT taking over
; the current default app — the user picks it as default in Windows if they want.

!macro capturaAssoc EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Captura.Image" ""
  WriteRegStr HKCU "Software\Classes\Applications\Captura.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro capturaUnassoc EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Captura.Image"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Captura.Image" "" "Captura image"
  WriteRegStr HKCU "Software\Classes\Captura.Image" "FriendlyTypeName" "Captura image"
  WriteRegStr HKCU "Software\Classes\Captura.Image\DefaultIcon" "" "$INSTDIR\Captura.exe,0"
  WriteRegStr HKCU "Software\Classes\Captura.Image\shell\open" "FriendlyAppName" "Captura"
  WriteRegStr HKCU "Software\Classes\Captura.Image\shell\open\command" "" '"$INSTDIR\Captura.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Captura.exe" "FriendlyAppName" "Captura"
  WriteRegStr HKCU "Software\Classes\Applications\Captura.exe\shell\open\command" "" '"$INSTDIR\Captura.exe" "%1"'
  !insertmacro capturaAssoc "jpg"
  !insertmacro capturaAssoc "jpeg"
  !insertmacro capturaAssoc "jfif"
  !insertmacro capturaAssoc "png"
  !insertmacro capturaAssoc "webp"
  !insertmacro capturaAssoc "gif"
  !insertmacro capturaAssoc "bmp"
  !insertmacro capturaAssoc "avif"
  ; tell Explorer that file associations changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro capturaUnassoc "jpg"
  !insertmacro capturaUnassoc "jpeg"
  !insertmacro capturaUnassoc "jfif"
  !insertmacro capturaUnassoc "png"
  !insertmacro capturaUnassoc "webp"
  !insertmacro capturaUnassoc "gif"
  !insertmacro capturaUnassoc "bmp"
  !insertmacro capturaUnassoc "avif"
  DeleteRegKey HKCU "Software\Classes\Captura.Image"
  DeleteRegKey HKCU "Software\Classes\Applications\Captura.exe"
  ; remove the "Start with Windows" entry if it was turned on
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Captura"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
