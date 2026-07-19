; Broker Demand Desk - Windows installer
; Bundles the app + a portable Node.js runtime, so nothing extra needs to be
; installed on the target machine (no Node.js, no Docker - the database is
; an embedded SQLite file created on first run).

#define MyAppVersion "1.5.5"
#define MyAppPublisher "Prashant Sanghavi"
#define MyAppExeDesc "Excel to WhatsApp demand automation"

#ifdef FRESH_TEST
#define MyAppName "Broker Demand Desk Fresh Test"
#define MyAppId "{{F18D9C70-41AF-4F31-A707-3C1EE97523B4}"
#define MyDefaultDirName "{localappdata}\BrokerDemandDesk-FreshTest-1.5.5"
#define MyOutputBaseFilename "BrokerDemandDesk-Fresh-Test-1.5.5"
#else
#define MyAppName "Broker Demand Desk"
#define MyAppId "{{B5E3B8E1-6B7A-4C2B-9C5B-1B7B2B7B2B7B}"
#define MyDefaultDirName "{localappdata}\BrokerDemandDesk"
#define MyOutputBaseFilename "BrokerDemandDesk-Setup-1.5.5"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
VersionInfoVersion=1.5.5.0
VersionInfoProductVersion=1.5.5.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppExeDesc}
VersionInfoOriginalFileName={#MyOutputBaseFilename}.exe
DefaultDirName={#MyDefaultDirName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
; Per-user install (no admin/UAC prompt needed)
PrivilegesRequired=lowest
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename={#MyOutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Inert unless build.ps1 passes /DSIGNTOOL_NAME (only happens when a real
; code-signing certificate is configured) - an unsigned build compiles
; identically to before, no SignTool directive at all.
#ifdef SIGNTOOL_NAME
SignTool={#SIGNTOOL_NAME}
#endif

[Files]
; The app itself (source, public assets, node_modules with Chromium already
; downloaded - excludes local dev/runtime data so each install starts clean).
; A leading backslash anchors each exclusion to the app source root. Without
; it, e.g. "tmp\*" also removes the required node_modules\tmp dependency.
Source: "..\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion; Excludes: "\data\*,\incoming\*,\processed\*,\attachments\*,\failed-imports\*,\.wwebjs_auth\*,\.wwebjs_cache\*,\test\*,\coverage\*,\tmp\*,\.playwright-cli\*,\.env*,\*.log"
; Portable Node.js runtime, so the target machine needs nothing preinstalled.
Source: "runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs ignoreversion

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Icons]
; .vbs files aren't Win32 executables, so every launch point goes through
; wscript.exe explicitly rather than relying on CreateProcess/file-association
; resolution (which fails with error 193 for scripts).
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Start Broker Demand Desk.vbs"""; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"
Name: "{group}\Stop {#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Stop Broker Demand Desk.vbs"""; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Start Broker Demand Desk.vbs"""; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\Start Broker Demand Desk.vbs"""; WorkingDir: "{app}"; Description: "Launch {#MyAppName} now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\Stop Broker Demand Desk.vbs"""; WorkingDir: "{app}"; RunOnceId: "StopBrokerDemandDesk"; Flags: runhidden waituntilterminated

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  StopScript: String;
  PowerShellExe: String;
  StopParameters: String;
  ResultCode: Integer;
begin
  Result := '';
  StopScript := ExpandConstant('{app}\stop.ps1');
  if not FileExists(StopScript) then
    Exit;

  PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  StopParameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    StopScript + '" -Quiet';

  if not Exec(PowerShellExe, StopParameters, ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    Result := 'Broker Demand Desk could not be stopped safely. Close it and try the installation again.';
    Exit;
  end;

  if ResultCode <> 0 then
    Result := 'Broker Demand Desk reported an error while stopping. Close it and try the installation again.';
end;

// The [Files] section deliberately excludes data\, incoming\, processed\,
// attachments\, failed-imports\, .wwebjs_auth\, .wwebjs_cache\ (see
// installer-definition.test.js) so an in-place upgrade never wipes the
// database, the linked WhatsApp session, the device password, or Settings -
// this is LIFE-002's whole point. But it means Inno's uninstaller, which only
// ever removes what it tracked installing, NEVER removes those folders on an
// actual uninstall either. Left behind, a "fresh" reinstall silently resumes
// the old password/WhatsApp link/database - which reads exactly like "it's
// still installed" even though Windows genuinely did uninstall it. This is
// opt-in and scoped to usPostUninstall (an explicit uninstall only) - a
// normal version-to-version upgrade never runs the uninstaller at all, so it
// can never accidentally trigger this prompt.
procedure RemoveLocalAppData();
var
  ExtraDirs: array[0..6] of String;
  i: Integer;
begin
  ExtraDirs[0] := ExpandConstant('{app}\data');
  ExtraDirs[1] := ExpandConstant('{app}\incoming');
  ExtraDirs[2] := ExpandConstant('{app}\processed');
  ExtraDirs[3] := ExpandConstant('{app}\attachments');
  ExtraDirs[4] := ExpandConstant('{app}\failed-imports');
  ExtraDirs[5] := ExpandConstant('{app}\.wwebjs_auth');
  ExtraDirs[6] := ExpandConstant('{app}\.wwebjs_cache');
  for i := 0 to GetArrayLength(ExtraDirs) - 1 do
  begin
    if DirExists(ExtraDirs[i]) then
      DelTree(ExtraDirs[i], True, True, True);
  end;
  // Only removes {app} itself if it's now actually empty - Inno's own
  // uninstall of tracked files already ran before usPostUninstall, so this
  // only succeeds once nothing but the folders just deleted above remained.
  if DirExists(ExpandConstant('{app}')) then
    RemoveDir(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox(
      'Also permanently delete Broker Demand Desk''s local data on this PC?' + #13#10 + #13#10 +
      'This includes the message/broker database, the linked WhatsApp login session, the device password, and Settings (column mapping, message template, backup folder).' + #13#10 + #13#10 +
      'Choose No to keep this data - for example, if you plan to reinstall and pick up right where you left off (this is what a normal upgrade already does automatically).' + #13#10 + #13#10 +
      'Choose Yes only for a completely clean removal. This cannot be undone.',
      mbConfirmation, MB_YESNO) = IDYES then
      RemoveLocalAppData();
  end;
end;
