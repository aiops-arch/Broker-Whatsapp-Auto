# Changelog

## 1.4.0

- Add a cross-import "possible duplicate" flag: the same party/stones reaching the same phone number from a different import or file is flagged, never silently skipped and never hard-blocked. Sending a flagged row requires one explicit confirmation; bulk sends and auto-send always skip it instead.
- Add an opt-in, off-by-default **Automatic sending** toggle in Settings: a just-imported, complete, non-duplicate-flagged row can send immediately with no manual click, while incomplete or flagged rows always wait for review. Never affects drafts already queued before the toggle was enabled.
- Report duplicate-import outcomes to the operator (e.g. "8 new, 3 already imported") instead of a re-imported workbook looking identical to a fresh one.
- Fix: a race between the exact-duplicate check and the database insert could previously quarantine an entire otherwise-valid workbook; it now skips only the racing duplicate row.
- Fix: a database failure while recording a definite send failure could previously mislabel it as "maybe delivered" on the next restart; it now correctly falls back to the uncertain-delivery state.
- Fix: double-clicking "Refresh code" during WhatsApp setup could run two refreshes concurrently against the same browser page; a second refresh now waits instead of racing the first.
- Fix: selecting a backup folder inside the application's own data or install directory (which would destroy backups alongside the data they protect) is now rejected.
- Fix: repeatedly saving the column mapping in Settings no longer accumulates duplicate event listeners on the message template editor.
- Fix: changing a mapped field's role away from Group/Header no longer leaves a stale, meaningless flag checked in the mapping table.
- Change the default message template: the buyer's name no longer appears mid-message and the signature is now "Regards," followed by the buyer's name, instead of a fixed sender name.
- Register the new flows (`DRAFT-004`, `SEND-007`, `IMP-005`, `IMP-006`) in `docs/FEATURE_FLOWS.md` and amend the "no message sent without an explicit operator action" safety rule to precisely describe the opt-in auto-send exception.

## 1.3.0

- Add configurable per-installation column mapping: map any workbook's own column names to broker name/phone, grouping fields, header info, line items and an attachment field, instead of a fixed header set.
- Add a configurable, `{{placeholder}}`-based message template and line-item template, with a live preview and safe (non-executing) rendering.
- Add a "Reset to default" action for both mapping and template, and an "Auto-detect from a sample file" action that reads a workbook's header row to help fill in the mapping.
- Add a guided first-run Setup Wizard (column mapping, message template, backup folder/time) that appears once after WhatsApp linking, and remains re-runnable from Settings at any time.
- Redesign the dashboard around a sidebar (Dashboard, Messages, Brokers, Backups, Settings) instead of a single flat page, with a new Settings screen for column mapping and message template.
- Default mapping and template reproduce the application's original fixed behavior exactly, so existing installations are unaffected until an operator changes Settings.
- Register the new configuration flows (`CONFIG-001` to `CONFIG-004`) in `docs/FEATURE_FLOWS.md`.

## 1.2.5

- Persist dashboard authentication in local SQLite across server/watchdog restarts.
- Use a rolling 30-minute inactivity timeout.
- Contain recoverable WhatsApp/Puppeteer detached-frame navigation races.
- Add a per-PC custom daily backup time with immediate rescheduling.
- Coalesce server-sent events and fallback refreshes to reduce UI lag during sends.
- Add professional card, button, modal and responsive animations.
- Remove mobile page-level horizontal overflow.
- Add persistent-session, custom-schedule and browser-layout verification.
- Register all supported lifecycle, authentication, WhatsApp, import, draft,
  send, backup, interface and diagnostic flows in `docs/FEATURE_FLOWS.md`.

## 1.2.4

- Prevent malformed WhatsApp delivery acknowledgements from reaching SQLite.
- Contain acknowledgement persistence errors so they cannot crash the server.

## 1.2.3

- Fix single-file multipart uploads being rejected by an incorrect parts limit.
- Improve upload validation, selected-file feedback and error messages.
- Make the native backup folder chooser owned/topmost.
- Replace the duplicate-looking native file control with a styled accessible picker.

## 1.2.2

- Correct installer exclusions so required nested runtime dependencies are included.
- Harden launcher health checks, duplicate-start behavior and recovery.

## Earlier releases

- Introduced independent per-installation configuration and data paths.
- Added phone-code/QR WhatsApp setup and password recovery through the linked account.
- Added safe workbook validation, explicit draft review, send idempotency and uncertain-delivery reconciliation.
- Added scheduled local SQLite backups and Windows installer/uninstaller support.
