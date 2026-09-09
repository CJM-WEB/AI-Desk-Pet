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

; 安装器只封装已由 electron-builder 生成并校验的完整离线发行目录。
[Setup]
AppId=com.myself.desktop
AppName=AI Pet
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersionNumeric}
SetupArchitecture=x64
MinVersion=10.0
DefaultDirName={localappdata}\Programs\AI Pet
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=AI-Pet-{#AppVersion}-windows-x64
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\AI Pet.exe
Compression=lzma2/normal
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
; 递归复制完整目录，模型、许可和固定 helper 不在此处重新筛选。
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\AI Pet"; Filename: "{app}\AI Pet.exe"
Name: "{autodesktop}\AI Pet"; Filename: "{app}\AI Pet.exe"
