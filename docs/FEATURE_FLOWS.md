# Feature Flow Registry

This registry defines the supported product behavior of Broker Demand Desk. Each flow has a stable identifier so requirements, tests, support reports and release notes can refer to the same operation unambiguously.

## Registry conventions

Each flow records:

- **Trigger** — the user or system event that starts the flow.
- **Prerequisites** — conditions that must already be true.
- **Flow** — the ordered behavior expected from the application.
- **Success** — the observable completed state.
- **Failure/recovery** — how the application fails safely and how the operator proceeds.
- **Persistence** — local state read or changed by the flow.

Safety rules that apply to every flow:

1. Department installations remain independent.
2. No message is sent without an explicit operator action, except an opt-in, off-by-default auto-send of a just-completed import's own complete, non-duplicate-flagged rows (`IMP-005`).
3. Unknown delivery is never treated as a definite failure or retried automatically.
4. Operational secrets and WhatsApp profiles remain local and are never committed to Git.
5. Upgrades preserve device data unless the operator explicitly requests removal.
6. A possible duplicate (same party/stones reaching the same phone number from a different import) is flagged, never silently sent and never hard-blocked - one explicit operator confirmation lets it through (`DRAFT-004`, `SEND-007`).

---

## Installation and lifecycle

### LIFE-001 — Fresh installation

- **Trigger:** User runs the current setup EXE.
- **Prerequisites:** Windows 10/11 x64 and a writable per-user LocalAppData location.
- **Flow:** Installer copies the application, bundled Node.js, bundled Chromium, launcher scripts and shortcuts; registers an uninstaller; starts the local app.
- **Success:** Start-menu/desktop entry opens the dashboard at the installation's loopback URL without requiring Node, npm, Docker or a separate database.
- **Failure/recovery:** Installer reports failure without creating a usable partial shortcut. Re-run after resolving security-software, disk-space or file-lock issues.
- **Persistence:** Application binaries and initial device folders under the installation directory.

### LIFE-002 — In-place upgrade

- **Trigger:** User runs a newer installer over an existing installation.
- **Prerequisites:** Existing installation; no active bulk send should be in progress.
- **Flow:** Setup requests bounded shutdown, replaces application/runtime files and keeps excluded operational folders.
- **Success:** New product version runs with the existing password, database, WhatsApp profile, workbooks, attachments and backup configuration.
- **Failure/recovery:** Existing device data remains preserved. Re-run the installer; do not uninstall first.
- **Persistence:** Binaries change; operational data does not.

### LIFE-003 — Start, singleton detection and watchdog recovery

- **Trigger:** User starts the app or clicks its shortcut again.
- **Prerequisites:** Valid installation configuration and free configured port, or the same healthy app already listening.
- **Flow:** Launcher derives an installation-specific mutex, validates configuration, checks the health endpoint, opens the healthy dashboard or starts the bundled server and monitors it.
- **Success:** Exactly one healthy server instance exists for that installation and the dashboard opens.
- **Failure/recovery:** An unrelated port owner is not mistaken for this app. Startup failures are written to watchdog/server logs and shown to the user. The watchdog can restart a stopped local process.
- **Persistence:** `data/config.json`, PID/stop files and bounded logs.

### LIFE-004 — Stop and uninstall

- **Trigger:** User chooses Stop or Windows Uninstall.
- **Prerequisites:** Installed application.
- **Flow:** Stop requests graceful HTTP/WhatsApp shutdown, then performs path-contained cleanup of owned descendants if required. Uninstall removes registered application files and shortcuts.
- **Success:** No owned server/browser process remains. Application entry is removed.
- **Failure/recovery:** Forced cleanup is limited to processes belonging to the intended installation. Retained operational folders can be backed up or removed manually later.
- **Persistence:** Operational data is intentionally preserved by uninstall to prevent accidental loss.

---

## Authentication and recovery

### AUTH-001 — First-run password creation

- **Trigger:** Dashboard opens and no password hash exists.
- **Prerequisites:** Healthy local server.
- **Flow:** User enters and confirms a password of at least eight characters; server hashes it, stores only the hash, regenerates the session and authenticates the browser.
- **Success:** Dashboard becomes available and the browser has a persisted authenticated session.
- **Failure/recovery:** Weak/mismatched input is rejected. Database errors leave setup incomplete and do not store plain text.
- **Persistence:** Password hash, installation session secret and SQLite session record.

### AUTH-002 — Login, rolling timeout and restart survival

- **Trigger:** User signs in with the device password.
- **Prerequisites:** Password already configured.
- **Flow:** Server verifies the hash, regenerates the browser session and stores it in SQLite. Each active request rolls the expiry forward.
- **Success:** Login remains active until 30 minutes of inactivity and survives a local server/watchdog restart during that period.
- **Failure/recovery:** Wrong password returns an error without authenticating. Expired/missing sessions return to the login gate.
- **Persistence:** Installation-local `app_sessions` record; no password in the cookie.

### AUTH-003 — Explicit logout

- **Trigger:** User chooses **Log out**.
- **Prerequisites:** Authenticated session.
- **Flow:** Server destroys that session and browser reloads the authentication gate.
- **Success:** Protected APIs are no longer accessible with the previous cookie.
- **Failure/recovery:** A stale page receives `401` and reloads to the login gate.
- **Persistence:** Current session record removed.

### AUTH-004 — Change password

- **Trigger:** Authenticated user chooses **Change password**.
- **Prerequisites:** Correct current password and valid new password.
- **Flow:** Server verifies current password, stores the new hash, clears recovery state and invalidates every persisted login session.
- **Success:** All browsers must sign in with the new password.
- **Failure/recovery:** Wrong current password or weak new password leaves the old password/sessions unchanged.
- **Persistence:** Password hash replaced; all session rows cleared.

### AUTH-005 — Forgot-password recovery through linked WhatsApp

- **Trigger:** User chooses **Forgot password?**.
- **Prerequisites:** This installation's own WhatsApp identity is linked, ready and internally consistent.
- **Flow:** App creates a short-lived one-time code, stores only its hash in memory, sends it to the account's own WhatsApp chat, enforces cooldown/attempt limits, verifies it and accepts a new password.
- **Success:** New password is stored and all old sessions are invalidated.
- **Failure/recovery:** Recovery remains unavailable when WhatsApp is disconnected/stale; delivery failure leaves no active reset code; expired/used/over-attempted codes are rejected.
- **Persistence:** New password hash; transient recovery material is not persisted in plain text.

---

## WhatsApp connection

### WA-001 — Silent saved-session restore

- **Trigger:** Server/provider starts.
- **Prerequisites:** Installation-local WhatsApp `LocalAuth` profile may exist.
- **Flow:** Provider launches owned headless Chromium and attempts silent authentication. A valid profile progresses to authenticated/ready without requesting a new code.
- **Success:** Status becomes **Connected** and sending/recovery controls are enabled.
- **Failure/recovery:** Missing/invalid profile transitions to setup-needed rather than displaying a stale QR. Browser startup and authenticated-ready waits are bounded.
- **Persistence:** `data/wwebjs_auth` remains local and survives upgrades/restarts.

### WA-002 — Link using phone code

- **Trigger:** User enters a department phone number and chooses **Get phone code**.
- **Prerequisites:** Valid international number or supported local number with configured country code.
- **Flow:** Number is normalized, a setup client starts, pairing code is requested and shown with phone instructions.
- **Success:** Phone accepts the link; provider reaches authenticated then ready.
- **Failure/recovery:** Invalid number is rejected. Refresh requests a new code on a healthy client or performs bounded client recovery.
- **Persistence:** Successful LocalAuth profile and last setup method/number in provider state.

### WA-003 — Link using QR code

- **Trigger:** User chooses **Use QR code** or switches from phone setup.
- **Prerequisites:** Setup-required/non-ready state.
- **Flow:** Provider requests a current QR, safely encodes the newest revision and displays it with scan instructions.
- **Success:** Scan authenticates and provider reaches ready.
- **Failure/recovery:** Stale asynchronous QR results cannot replace newer ones. Refresh uses the healthy page first and falls back to a bounded restart. Invalid/missing QR data displays recovery controls.
- **Persistence:** Successful LocalAuth profile.

### WA-004 — Switch setup method

- **Trigger:** User chooses **Switch to QR**, **Switch to phone code**, or another phone number.
- **Prerequisites:** WhatsApp not ready.
- **Flow:** Current setup generation is retired; old asynchronous results are ignored; requested method starts cleanly.
- **Success:** Only the selected setup method controls the visible code/state.
- **Failure/recovery:** Bounded cleanup prevents a hung old Chromium client from blocking the new flow.
- **Persistence:** Existing ready profile is never erased by mere method switching.

### WA-005 — Disconnect and change number

- **Trigger:** User confirms **Disconnect and change number** while connected.
- **Prerequisites:** Ready linked account and explicit confirmation.
- **Flow:** Provider logs out the linked account, closes owned browser resources and returns to setup-needed.
- **Success:** Old account is disconnected and a new phone/QR flow can begin.
- **Failure/recovery:** Logout/destroy operations are bounded; errors are reported without targeting unrelated browser processes.
- **Persistence:** Ready LocalAuth state is intentionally invalidated only after this explicit action.

### WA-006 — Reset incomplete setup

- **Trigger:** User confirms **Reset WhatsApp setup**.
- **Prerequisites:** Setup is incomplete/non-ready.
- **Flow:** Provider stops owned clients, validates that the auth path is contained and not a link/junction, then removes only the incomplete session.
- **Success:** Setup returns to a clean phone/QR choice.
- **Failure/recovery:** Reset refuses a ready account and refuses linked/junction paths.
- **Persistence:** Only contained incomplete LocalAuth data is removed.

---

## Workbook import

### IMP-001 — Manual browser upload

- **Trigger:** User chooses one file and selects **Upload & process**.
- **Prerequisites:** Authenticated dashboard; one `.xlsx` file no larger than 10 MB.
- **Flow:** Browser validates selection, submits one multipart file, server isolates it in staging, validates XLSX/schema and queues it into the local import path.
- **Success:** UI reports **Workbook validated and queued for local processing**; drafts appear after processing.
- **Failure/recovery:** Extra parts/files, wrong extension, oversized or invalid content are rejected with specific messages. Selection remains available after a failed request.
- **Persistence:** Temporary staging file followed by incoming/failed location.

### IMP-002 — Drop-folder import

- **Trigger:** A stable workbook appears in `incoming`.
- **Prerequisites:** `.xlsx` file fully written and watcher active.
- **Flow:** Watcher waits for write stability, validates the workbook, creates grouped drafts and archives the source.
- **Success:** Workbook moves to `processed`; message rows appear in the dashboard.
- **Failure/recovery:** Processing errors move the file to `failed-imports` with a readable sidecar when possible.
- **Persistence:** Incoming, processed/failed file and SQLite message rows.

### IMP-003 — Workbook structural and business validation

- **Trigger:** Any upload/drop import.
- **Prerequisites:** Isolated candidate file.
- **Flow:** Verify XLSX ZIP/container, locate worksheet/header row, require all registered headers, reject header-only workbooks and reject partially populated essential business rows.
- **Success:** Normalized demand groups returned to the watcher.
- **Failure/recovery:** No drafts/messages are sent; operator receives exact missing/invalid reason.
- **Persistence:** Failure report only; no partial draft commit.

### IMP-004 — Filename isolation and quarantine

- **Trigger:** Import name received from HTTP or filesystem.
- **Prerequisites:** Untrusted filename/path.
- **Flow:** Remove traversal, control/reserved characters and Windows device names; use collision-safe exclusive moves and unique suffixes.
- **Success:** File remains inside the intended installation folder without overwriting an existing file.
- **Failure/recovery:** Collision retries with a suffix; failed import is retained with timestamped name/error sidecar.
- **Persistence:** Sanitized local filename.

### IMP-005 — Opt-in auto-send of a completed import

- **Trigger:** A workbook import finishes successfully and the operator has turned on **Automatic sending** in Settings.
- **Prerequisites:** WhatsApp ready; setting enabled.
- **Flow:** Only the rows just created by this import are handed to the same send path bulk-send uses; a row sends only if it is complete (broker and phone known), carries no possible-duplicate flag, and WhatsApp is ready.
- **Success:** Eligible rows are marked `sent` and tagged as auto-sent; ineligible rows (`needs_info`, duplicate-flagged, or WhatsApp not ready) are left untouched for manual review.
- **Failure/recovery:** The setting never retroactively sends drafts already sitting in the queue from before it was enabled or from an earlier import. A send failure during auto-send follows the same per-row failure/uncertain handling as any other send.
- **Persistence:** `auto_send_enabled` setting; `auto_sent` flag on sent rows.

### IMP-006 — Duplicate-import visibility

- **Trigger:** A workbook import completes (upload or drop-folder), whether or not it introduced any new rows.
- **Prerequisites:** None.
- **Flow:** The count of newly inserted rows, exact re-import duplicates skipped, and possible-duplicate rows flagged is published as an import summary, shown to the operator as a toast.
- **Success:** Re-importing an already-imported workbook is visibly reported as "0 new, N already imported" instead of looking identical to a fresh import.
- **Failure/recovery:** A concurrent import racing an exact duplicate row is skipped and counted, not treated as a fatal error that quarantines the rest of the file.
- **Persistence:** None beyond the existing `messages_log` rows already covered by `DRAFT-002`.

---

## Broker and draft management

### DRAFT-001 — Broker directory maintenance

- **Trigger:** Import discovers a broker, or user saves/removes a broker entry.
- **Prerequisites:** Authenticated dashboard.
- **Flow:** Upsert name/phone, list/search locally, allow edit-by-selection and confirmed removal.
- **Success:** Drafts can resolve the broker's phone number.
- **Failure/recovery:** Missing phone keeps affected rows in **Needs info**; past logs remain unchanged after directory removal.
- **Persistence:** Local `brokers` table.

### DRAFT-002 — Draft generation and grouping

- **Trigger:** Valid workbook group returned by parser.
- **Prerequisites:** Required row values available.
- **Flow:** Group demand by broker/party, calculate stone count, create formatted message and deduplication key, resolve phone/attachment and assign `draft` or `needs_info`.
- **Success:** Reviewable message row appears exactly once.
- **Failure/recovery:** Existing deduplication key is not duplicated; incomplete contact data remains non-sendable.
- **Persistence:** `messages_log` row and source-file reference.

### DRAFT-003 — Review and edit

- **Trigger:** Operator opens a reviewable row.
- **Prerequisites:** Row in `needs_info`, `draft` or definite `failed` state.
- **Flow:** Display message metadata/content; operator corrects phone/message/attachment; server revalidates changes.
- **Success:** Complete row becomes sendable draft.
- **Failure/recovery:** Sent/sending/uncertain rows are not silently edited into a retryable state.
- **Persistence:** Updated message row and optional broker phone.

### DRAFT-004 — Possible-duplicate flag

- **Trigger:** A new row is inserted whose resolved phone number, party, and stone/line signature match an existing row (any status except `failed`).
- **Prerequisites:** A phone number is resolved for the new row.
- **Flow:** The match is computed independently of broker/date/exact wording, so it also catches the same demand arriving from a different file/import, not just an exact re-import. The row is created normally with its usual `draft`/`needs_info` status, plus a reference to the earlier matching row.
- **Success:** The operator sees a visible "Possible duplicate" indicator and a clear reference to the earlier message; nothing is blocked or silently skipped.
- **Failure/recovery:** The flag is informational and permanent - it is never auto-cleared. See `SEND-007` for how a flagged row is actually sent.
- **Persistence:** `content_signature` and `duplicate_of_id` on the new `messages_log` row.

---

## Sending and delivery safety

### SEND-001 — Send one reviewed message

- **Trigger:** Operator chooses **Send** on one row.
- **Prerequisites:** WhatsApp ready; row in sendable state; valid phone/attachment.
- **Flow:** Atomically claim row as `sending`, hand it once to provider, record WhatsApp message ID and mark sent.
- **Success:** Row becomes `sent`; UI displays result and later delivery acknowledgements.
- **Failure/recovery:** Definite provider failure marks `failed`; concurrent/duplicate request is blocked.
- **Persistence:** Send state, WhatsApp ID, timestamps and error if any.

### SEND-002 — Send selected drafts

- **Trigger:** Operator checks rows and chooses **Send selected**.
- **Prerequisites:** One or more visible sendable rows and WhatsApp ready.
- **Flow:** Deduplicate requested IDs, process each through the same atomic single-send coordinator and respect provider pacing.
- **Success:** Each row records its own result; selection updates as rows leave sendable state.
- **Failure/recovery:** One row's failure does not make another row automatically retry. Results are reported individually.
- **Persistence:** Per-row state transitions.

### SEND-003 — Send all drafts

- **Trigger:** Operator explicitly chooses **Send all drafts**.
- **Prerequisites:** WhatsApp ready and local drafts available.
- **Flow:** Snapshot eligible draft IDs and process them through the atomic coordinator with human-like delay.
- **Success:** Eligible drafts are processed once.
- **Failure/recovery:** Needs-info, sent, sending and uncertain rows remain excluded.
- **Persistence:** Per-row send results.

### SEND-004 — Attachment validation and send

- **Trigger:** Sendable row references an attachment.
- **Prerequisites:** Attachment basename resolves inside the installation attachment directory.
- **Flow:** Reject traversal/missing/non-file/oversized/unsupported content; load approved JPG/JPEG/PNG/WEBP/MP4/3GP/PDF and send with caption.
- **Success:** WhatsApp provider returns the outbound message ID.
- **Failure/recovery:** Attachment rejection produces definite failure before unsafe access/send.
- **Persistence:** Attachment path and send error/status.

### SEND-005 — Delivery acknowledgement tracking

- **Trigger:** WhatsApp emits acknowledgement for an outbound message.
- **Prerequisites:** Valid serialized WhatsApp message ID and recognized acknowledgement label.
- **Flow:** Map acknowledgement to `sent`, `delivered` or `read`; update matching row by WhatsApp ID; notify UI.
- **Success:** Delivery indicator advances without changing the send decision.
- **Failure/recovery:** Missing/malformed/internal acknowledgement IDs are ignored; database errors are contained and cannot restart the server.
- **Persistence:** `delivery_status` only.

### SEND-006 — Interrupted/uncertain send reconciliation

- **Trigger:** Process restarts while a row is `sending`, or send completion cannot be proven.
- **Prerequisites:** Previously claimed row.
- **Flow:** Startup converts unfinished claim to `send_uncertain`; UI requires operator to verify the actual WhatsApp conversation.
- **Success:** Operator marks delivered, or explicitly confirms non-delivery and approves one retry.
- **Failure/recovery:** Automatic retry is prohibited; sent/ordinary rows cannot use uncertain reconciliation.
- **Persistence:** Uncertain status, reconciliation decision/note/time and optional one-time retry state.

### SEND-007 — Confirm-to-send a possible duplicate

- **Trigger:** Operator chooses **Send** or **Retry** on a row flagged by `DRAFT-004`.
- **Prerequisites:** Row otherwise sendable (`draft` or `failed`, broker and phone known).
- **Flow:** The first attempt is rejected with the duplicate reason instead of sending; the operator explicitly confirms, and only that confirmed, single-row attempt is allowed through.
- **Success:** The confirmed row sends exactly like any other explicit send.
- **Failure/recovery:** Bulk actions (**Send selected**, **Send all drafts**) and auto-send (`IMP-005`) never confirm on the operator's behalf - a flagged row in a bulk batch is skipped and reported, never sent silently.
- **Persistence:** Same as `SEND-001`; the `duplicate_of_id` reference is not cleared by sending.

---

## Backups

### BACKUP-001 — Select/validate backup folder

- **Trigger:** User chooses **Choose folder**.
- **Prerequisites:** Authenticated dashboard on Windows.
- **Flow:** Foreground owned native chooser returns a path; server normalizes it, creates it when needed and performs an exclusive write probe.
- **Success:** Folder is stored for this installation and an immediate manual baseline is created on first selection.
- **Failure/recovery:** Cancel changes nothing. Invalid/unwritable paths report a clear error.
- **Persistence:** `backup_root`, baseline snapshot and last-success/error settings.

### BACKUP-002 — Configure per-PC daily time

- **Trigger:** User chooses a time and selects **Save time**.
- **Prerequisites:** Valid local `HH:MM` value.
- **Flow:** Server validates/stores `backup_time_local`, recalculates the latest due boundary and immediately reschedules the timer.
- **Success:** Backup card shows the device-local display time and next run; setting survives restart.
- **Failure/recovery:** Invalid time is rejected without replacing the previous schedule.
- **Persistence:** This PC's `backup_time_local` setting only.

### BACKUP-003 — Scheduled backup, sleep catch-up and deduplication

- **Trigger:** Device reaches the chosen local time, or restarts after a missed latest boundary.
- **Prerequisites:** Configured writable folder.
- **Flow:** Determine latest due boundary, skip if already covered, create one SQLite-safe snapshot in `YYYY/MM`, then schedule the next day.
- **Success:** Non-empty `broker-demand-YYYY-MM-DD.db` exists and status records success.
- **Failure/recovery:** Do not manufacture multiple historical snapshots after long sleep. Failed scheduled run enters retry flow.
- **Persistence:** Snapshot and last-success setting.

### BACKUP-004 — Scheduled backup retry

- **Trigger:** Scheduled/catch-up backup fails.
- **Prerequisites:** Folder still configured.
- **Flow:** Remove temporary partial file, record sanitized error and schedule retry in 15 minutes.
- **Success:** Retry completes, clears stale error and resumes the normal daily schedule.
- **Failure/recovery:** Repeated failures remain visible and continue bounded retry scheduling without treating partial files as backups.
- **Persistence:** Last-error setting; successful retry snapshot.

### BACKUP-005 — Manual backup now

- **Trigger:** User chooses **Back up now**.
- **Prerequisites:** Configured writable folder.
- **Flow:** Create SQLite-safe timestamped manual snapshot in current `YYYY/MM` folder using collision-safe naming.
- **Success:** UI reports completion and updates last-backup details.
- **Failure/recovery:** Partial temp file is removed and clear error displayed.
- **Persistence:** Manual snapshot and last-success/error setting.

---

## Interface and diagnostics

### UI-001 — Live dashboard refresh

- **Trigger:** Server-sent update, initial boot or 15-second fallback timer.
- **Prerequisites:** Authenticated dashboard.
- **Flow:** Refresh WhatsApp status first, then backup/log/broker data concurrently. Coalesce rapid events into at most one follow-up refresh and reject stale status revisions.
- **Success:** Counts, connection, drafts and delivery indicators update without overlapping render floods.
- **Failure/recovery:** EventSource automatically reconnects; fallback polling continues; transient fetch failures keep last known status.
- **Persistence:** None beyond current browser state.

### UI-002 — Professional responsive interface and theme

- **Trigger:** Page load, viewport change or Theme action.
- **Prerequisites:** Modern Edge/Chrome browser.
- **Flow:** Render responsive cards/tables/modals, accessible controls, subtle animations, dark/light theme and reduced-motion support.
- **Success:** Desktop and narrow layouts remain usable without page-level horizontal overflow; selected theme survives reload.
- **Failure/recovery:** Wide data tables scroll inside their container rather than expanding the page.
- **Persistence:** Theme choice in browser local storage.

### UI-003 — Toasts, progress and operation feedback

- **Trigger:** Upload, send, backup, broker or setup action.
- **Prerequisites:** Visible dashboard.
- **Flow:** Disable active control, show spinner/status, report success/error, restore control and refresh affected data.
- **Success:** Operator can tell whether the action is pending, complete or needs attention.
- **Failure/recovery:** Error text remains actionable; failed upload keeps the selected filename; folder chooser displays an in-app foreground notice.
- **Persistence:** Operation result may update server state; transient UI feedback is not persisted.

### UI-004 — Runtime diagnostics and safe logging

- **Trigger:** Server start, console event, recoverable browser race or fatal error.
- **Prerequisites:** Writable data directory when available.
- **Flow:** Timestamp, redact common credentials/QR/session material, bound entry size and rotate logs.
- **Success:** Support has local diagnostics without unbounded files or obvious secret exposure.
- **Failure/recovery:** Logging never throws when destination is invalid/unwritable. Known transient Puppeteer navigation races are warnings, not process-fatal events.
- **Persistence:** Bounded `server.log` and rotated log in the installation data directory.

---

## Configuration

### CONFIG-001 — First-run Setup Wizard

- **Trigger:** WhatsApp reaches `ready` for the first time and the installation has not completed onboarding.
- **Prerequisites:** Authenticated dashboard; linked, ready WhatsApp.
- **Flow:** A guided overlay walks the operator through column mapping, message template (with live preview) and backup folder/time, reusing the same components as Settings. Any step can be skipped with "Not now"/"Skip for now".
- **Success:** Onboarding is marked complete; the operator can still revisit every step later from Settings.
- **Failure/recovery:** Skipping at any step leaves the already-seeded default mapping/template in effect - the installation remains fully usable without completing the wizard. A failed save at the mapping/template step shows the same validation errors as Settings and does not advance.
- **Persistence:** `setup_wizard_completed` setting; any mapping/template/backup changes made during the wizard persist exactly as they would from Settings.

### CONFIG-002 — Edit column mapping

- **Trigger:** Operator opens **Settings → Column Mapping**, edits fields and chooses **Save mapping** (or **Reset to default**).
- **Prerequisites:** Authenticated dashboard.
- **Flow:** Server validates exactly one broker-name field, at most one broker-phone/attachment field, at least one grouping field with exactly one primary grouping field, and unique field keys/column names before saving.
- **Success:** The mapping is stored for this installation and used by every import from then on.
- **Failure/recovery:** Invalid mappings are rejected with per-field error messages and are not saved; the previously saved mapping keeps governing imports until a valid one is saved.
- **Persistence:** `field_mapping_config_v1` setting only. Does not alter previously imported `messages_log` rows - only future imports are affected.

### CONFIG-003 — Edit message template with live preview

- **Trigger:** Operator opens **Settings → Message Template**, edits the message/line-item/buyer-line templates and chooses **Save template** (or **Reset to default**).
- **Prerequisites:** Authenticated dashboard; a valid column mapping already exists.
- **Flow:** Every keystroke re-renders an illustrative preview from sample data via safe, non-executing placeholder substitution. Saving validates that every `{{placeholder}}` corresponds to a mapped field (or a reserved computed name) before persisting.
- **Success:** The template is stored for this installation and used to render every message generated from then on.
- **Failure/recovery:** A template referencing an unmapped or misspelled placeholder is rejected with the exact offending placeholder name; the previously saved template keeps governing message rendering.
- **Persistence:** `message_template_config_v1` setting only. Does not alter previously imported `messages_log` rows - only future imports are affected.

### CONFIG-004 — Auto-detect columns from a sample file

- **Trigger:** Operator chooses **Auto-detect from a sample file** in the mapping editor (Settings or Setup Wizard) and selects one `.xlsx` file.
- **Prerequisites:** Authenticated dashboard.
- **Flow:** The server reads only the header row of the uploaded file (no data rows, no import, no queuing) and returns the column names found; the browser best-effort matches them against the mapping table's existing field labels and fills in "Your column name" where a match is found.
- **Success:** The operator reviews (and corrects, if needed) the suggested column names, then saves the mapping as in `CONFIG-002`.
- **Failure/recovery:** An invalid/unreadable/oversized file is rejected with the same operator-facing errors as workbook import; the mapping table is left unchanged.
- **Persistence:** None - the uploaded file is discarded immediately after its header row is read.

---

## Flow-to-test coverage

| Test file | Primary registered flows |
| --- | --- |
| `auth-recovery.test.js` | `AUTH-005` |
| `session-store.test.js` | `AUTH-002`, `AUTH-004` |
| `whatsapp-provider.test.js` | `WA-001` to `WA-006` |
| `excel-import.test.js` | `IMP-002`, `IMP-003`, `DRAFT-002`, `CONFIG-002` (default mapping reproduces legacy output byte-for-byte) |
| `message-config.test.js` | `CONFIG-002`, `CONFIG-003` (mapping/template validation and safe rendering) |
| `config-routes.test.js` | `CONFIG-002`, `CONFIG-003`, `CONFIG-004` |
| `import-files.test.js` | `IMP-001`, `IMP-004` |
| `upload-multipart.test.js` | `IMP-001` |
| `send-safety.test.js` | `SEND-001` to `SEND-003`, `SEND-005` to `SEND-007` |
| `attachment-policy.test.js` | `SEND-004` |
| `content-duplicate.test.js` | `DRAFT-004` |
| `auto-send.test.js` | `IMP-005` |
| `backup.test.js` | `BACKUP-001` to `BACKUP-005` |
| `runtime-logger.test.js` | `UI-004` |
| `installer-definition.test.js` | `LIFE-001`, `LIFE-002` |

Browser verification additionally covers `AUTH-002`, `BACKUP-002`, `UI-001`, `UI-002`, `UI-003`, `CONFIG-001` and `CONFIG-002`/`CONFIG-003` (Setup Wizard and Settings, including live preview) on desktop and narrow viewports.

## Change-control rule

When adding or materially changing a feature:

1. Add or update its registered flow here.
2. Identify the failure and recovery state explicitly.
3. Identify local persistence and department-isolation impact.
4. Add/update automated tests.
5. Update the README and changelog when operator-visible behavior changes.

