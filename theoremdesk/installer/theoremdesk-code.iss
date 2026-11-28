// TheoremDesk's second installer stage, the code: installs the local AI
// models (see theoremdesk.iss). Included at the end of code.iss's [Code]
// section. Event functions use <event(...)> attributes so they run
// alongside code.iss's own.

// TDModelCount, TDModelFile(I), TDModelUrl(I), TDModelSha(I), TDModelSize(I).
#include "theoremdesk-models-code.iss"

var
  TDDownloadPage: TDownloadWizardPage;
  // Where each model will come from: a verified local file, or '' to download.
  TDLocalSource: array of String;
  TDDownloaded: array of Boolean;

function TDModelsPath(): String;
begin
  Result := ExpandConstant('{#TDModelsDir}');
end;

function TDInstalledOk(I: Integer): Boolean;
var
  Size: Int64;
begin
  // Already installed (verified when it was placed): the right size is enough.
  Result := FileSize64(TDModelsPath() + '\' + TDModelFile(I), Size) and (Size = TDModelSize(I));
end;

function TDVerified(Path: String; I: Integer): Boolean;
var
  Size: Int64;
begin
  Result := False;
  if not FileSize64(Path, Size) or (Size <> TDModelSize(I)) then
    exit;
  try
    Result := CompareText(GetSHA256OfFile(Path), TDModelSha(I)) = 0;
  except
    Result := False;
  end;
end;

// A copy next to the installer: TheoremDesk-AI\<file>, or <file> itself.
function TDOfflineCopy(I: Integer): String;
var
  Candidate: String;
begin
  Result := '';
  Candidate := ExpandConstant('{src}\TheoremDesk-AI\') + TDModelFile(I);
  if not FileExists(Candidate) then
    Candidate := ExpandConstant('{src}\') + TDModelFile(I);
  if FileExists(Candidate) then begin
    Log('TheoremDesk: checking ' + Candidate);
    if TDVerified(Candidate, I) then
      Result := Candidate
    else
      Log('TheoremDesk: ' + Candidate + ' is not the pinned file; ignoring it');
  end;
end;

function TDOnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure TDPrepare();
var
  I: Integer;
begin
  SetArrayLength(TDLocalSource, TDModelCount);
  SetArrayLength(TDDownloaded, TDModelCount);
  for I := 0 to TDModelCount - 1 do begin
    TDLocalSource[I] := '';
    TDDownloaded[I] := False;
    if TDInstalledOk(I) then
      TDLocalSource[I] := '(installed)'
    else
      TDLocalSource[I] := TDOfflineCopy(I);
  end;
end;

// The install folder must leave room for the app's deepest file
// (TDLongestPath characters, measured when the installer was built): Windows
// paths are limited to 260 characters, and a longer one fails halfway.
<event('NextButtonClick')>
function TDCheckInstallFolder(CurPageID: Integer): Boolean;
var
  Room: Integer;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    exit;
  Room := 259 - {#TDLongestPath} - 1;
  if Length(WizardDirValue()) > Room then begin
    SuppressibleMsgBox('This folder''s path is too long for TheoremDesk: some of its files would go over Windows'' 260-character limit.' + #13#10#13#10 + 'Choose a folder of at most ' + IntToStr(Room) + ' characters (this one has ' + IntToStr(Length(WizardDirValue())) + '), such as the one suggested.', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

<event('InitializeWizard')>
procedure TDInitializeWizard();
begin
  TDDownloadPage := CreateDownloadPage('Downloading the local AI models', 'TheoremDesk downloads its local AI models once. Each is checked against its SHA-256. You can cancel: setup will still finish, and TheoremDesk offers the download later.', @TDOnDownloadProgress);
end;

// Interactive installs: download on a page of its own, with progress and Cancel.
<event('NextButtonClick')>
function TDNextButtonClick(CurPageID: Integer): Boolean;
var
  I: Integer;
  Needed: Boolean;
begin
  Result := True;
  if (CurPageID <> wpReady) or not WizardIsTaskSelected('theoremdeskai') then
    exit;
  TDPrepare();
  TDDownloadPage.Clear;
  Needed := False;
  for I := 0 to TDModelCount - 1 do
    if TDLocalSource[I] = '' then begin
      TDDownloadPage.Add(TDModelUrl(I), TDModelFile(I), TDModelSha(I));
      Needed := True;
    end;
  if not Needed then
    exit;
  TDDownloadPage.Show;
  try
    try
      TDDownloadPage.Download;
      for I := 0 to TDModelCount - 1 do
        if TDLocalSource[I] = '' then
          TDDownloaded[I] := True;
    except
      if TDDownloadPage.AbortedByUser then
        Log('TheoremDesk: model download cancelled')
      else
        SuppressibleMsgBox('The local AI models could not be downloaded:' + #13#10 + GetExceptionMessage + #13#10#13#10 + 'Setup will finish without them. TheoremDesk will offer the download the first time you use the local AI.', mbInformation, MB_OK, IDOK);
    end;
  finally
    TDDownloadPage.Hide;
  end;
end;

procedure TDInstallModel(I: Integer; Source: String);
var
  Target: String;
begin
  ForceDirectories(TDModelsPath());
  Target := TDModelsPath() + '\' + TDModelFile(I);
  DeleteFile(Target);
  // A download in {tmp} is on the same drive as the data folder as a rule: move it.
  if not RenameFile(Source, Target) then
    if not FileCopy(Source, Target, False) then
      Log('TheoremDesk: could not install ' + Target);
end;

<event('CurStepChanged')>
procedure TDCurStepChanged(CurStep: TSetupStep);
var
  I: Integer;
begin
  if (CurStep <> ssPostInstall) or not WizardIsTaskSelected('theoremdeskai') then
    exit;
  // A silent install may not have run the download page's step (Inno Setup
  // runs NextButtonClick in silent installs too, so usually it did): if
  // not, prepare and download here. Never twice.
  if WizardSilent() and (GetArrayLength(TDLocalSource) <> TDModelCount) then begin
    TDPrepare();
    for I := 0 to TDModelCount - 1 do
      if TDLocalSource[I] = '' then
        try
          DownloadTemporaryFile(TDModelUrl(I), TDModelFile(I), TDModelSha(I), @TDOnDownloadProgress);
          TDDownloaded[I] := True;
        except
          Log('TheoremDesk: download of ' + TDModelFile(I) + ' failed: ' + GetExceptionMessage);
        end;
  end;
  if GetArrayLength(TDLocalSource) <> TDModelCount then
    exit;
  for I := 0 to TDModelCount - 1 do
    if TDDownloaded[I] then
      TDInstallModel(I, ExpandConstant('{tmp}\') + TDModelFile(I))
    else if (TDLocalSource[I] <> '') and (TDLocalSource[I] <> '(installed)') then
      // From the offline folder: copy, leaving the original where it is.
      if not FileCopy(TDLocalSource[I], TDModelsPath() + '\' + TDModelFile(I), False) then
        Log('TheoremDesk: could not copy ' + TDLocalSource[I]);
end;
