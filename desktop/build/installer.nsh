; Meow-PDF installer (electron-builder NSIS include)
; Registers the app with Windows "Default apps" so that
; ms-settings:defaultapps?registeredAppUser=Meow-PDF opens its page (Windows 11),
; where the user can make Meow-PDF the default app for .pdf / .mpdf.
; The .pdf / .mpdf file types and their icons (build/pdf.ico, build/mpdf.ico) come from "fileAssociations" in package.json.

!macro customInstall
  WriteRegStr SHCTX "Software\Meow-PDF\Capabilities" "ApplicationName" "Meow-PDF"
  WriteRegStr SHCTX "Software\Meow-PDF\Capabilities" "ApplicationDescription" "PDF and document editor"
  WriteRegStr SHCTX "Software\Meow-PDF\Capabilities" "ApplicationIcon" "$INSTDIR\Meow-PDF.exe,0"
  WriteRegStr SHCTX "Software\Meow-PDF\Capabilities\FileAssociations" ".pdf" "MeowPDF.pdf"
  WriteRegStr SHCTX "Software\Meow-PDF\Capabilities\FileAssociations" ".mpdf" "MeowPDF.mpdf"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Meow-PDF" "Software\Meow-PDF\Capabilities"
  WriteRegStr SHCTX "Software\Classes\Applications\Meow-PDF.exe\SupportedTypes" ".pdf" ""
  WriteRegStr SHCTX "Software\Classes\Applications\Meow-PDF.exe\SupportedTypes" ".mpdf" ""
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "MeowPDF.pdf" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Meow-PDF"
  DeleteRegKey SHCTX "Software\Meow-PDF"
  DeleteRegKey SHCTX "Software\Classes\Applications\Meow-PDF.exe"
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "MeowPDF.pdf"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
