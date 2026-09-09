#ifndef AppVersion
  #error AppVersion 未定义
#endif
#ifndef AppVersionNumeric
  #error AppVersionNumeric 未定义
#endif
#ifndef SourceDir
  #error SourceDir 未定义
#endif
#ifndef OutputDir
  #error OutputDir 未定义
#endif

[Setup]
AppId=com.myself.desktop
AppName=AI Pet
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersionNumeric}
DefaultDirName={localappdata}\Programs\AI Pet
DisableDirPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=AI-Pet-{#AppVersion}-windows-x64
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\AI Pet.exe
Compression=lzma2/ultra64
SolidCompression=yes
DiskSpanning=no
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
WizardStyle=modern

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\AI Pet"; Filename: "{app}\AI Pet.exe"
Name: "{autodesktop}\AI Pet"; Filename: "{app}\AI Pet.exe"
