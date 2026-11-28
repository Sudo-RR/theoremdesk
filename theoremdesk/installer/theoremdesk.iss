; TheoremDesk's second installer stage: the local AI models.
;
; The models (over 6 GB) don't fit in a Windows installer, which must stay
; under 4 GB, so they aren't in it. Setup installs them instead, when the
; "local AI" task is ticked (it is by default):
;   - from a TheoremDesk-AI folder next to the installer, if one holds
;     them (for offline installs), else
;   - by downloading them during setup from their pinned addresses.
; Every file is checked against its SHA-256 before it's installed. If the
; download fails or is cancelled, setup still finishes, and TheoremDesk
; offers the same download the first time the local AI is used.
;
; They go into TheoremDesk's data folder, not the app folder, so updates
; never touch them: %LOCALAPPDATA%\TheoremDesk\models for a per-user
; install, %ProgramData%\TheoremDesk\models for all users. TheoremDesk
; looks for them in both. Uninstalling removes them.
;
; Installed by theoremdesk/installer/prepare_installer.sh, which copies the
; files next to code.iss, includes this one before code.iss's [Code]
; section and theoremdesk-code.iss at its end, and generates the model
; list (theoremdesk-models.iss, theoremdesk-models-code.iss) from
; theoremdesk/tools/tools.json. This part declares the task, folders and
; uninstall entries; theoremdesk-code.iss does the work.

#if InstallTarget == "user"
  #define TDModelsDir "{localappdata}\TheoremDesk\models"
#else
  #define TDModelsDir "{commonappdata}\TheoremDesk\models"
#endif

; TDModelsSizeText, and the models' [UninstallDelete] entries (which use TDModelsDir).
#include "theoremdesk-models.iss"

; TDLongestPath: the app's deepest relative file path, for the install-folder check.
#include "theoremdesk-paths.iss"

[Tasks]
Name: "theoremdeskai"; Description: "Install the local AI models ({#TDModelsSizeText}). Downloaded during setup, or taken from a TheoremDesk-AI folder next to this installer."; GroupDescription: "TheoremDesk local AI (offline, free):"

[Dirs]
Name: "{#TDModelsDir}"; Tasks: theoremdeskai
