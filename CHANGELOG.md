# Changelog

## 1.5.6

- Full audit of every place WhatsApp could disconnect. Found and fixed four paths that previously demanded an immediate manual re-link even though the saved login was completely untouched: a Chromium crash/unexpected browser close, a browser that fails to launch in time, an internal `initialize()` failure, and a login that gets stuck between "accepted" and "ready". All four now get the same automatic, silent reconnect already used for a plain network disconnect - the app tries far harder (up to ~8 hours of retrying, backing off gradually) before ever asking the operator to re-link, and only an actual phone-side unlink still requires it.
- The dashboard now clearly shows "reconnecting automatically - no action needed" during one of these automatic recoveries, instead of looking identical to the first-time setup screen and inviting the operator to restart linking mid-recovery.

- The uninstaller now asks whether to also permanently delete local application data (database, WhatsApp login session, device password, Settings) - previously it never removed this data at all (by design, so an in-place upgrade never loses anything), which meant a "fresh" reinstall after uninstalling silently resumed the old password/WhatsApp link/database instead of actually starting clean. Choosing No keeps today's exact preserve-on-upgrade behavior; choosing Yes gives a genuinely clean removal.

## 1.5.4

- Fix: the Archive table was rendering with none of the Messages table's styling (padding, column widths, font size) because every table-styling CSS rule targeted the Messages table's id specifically. Both tables now share one class so Archive looks and behaves identically to Messages.

## 1.5.3

- Add a delivery-confirmation safety net: a message is no longer assumed delivered the instant it's handed to WhatsApp. It now waits for WhatsApp's own acknowledgement before showing as confirmed, and if a "Sent" message goes more than 2 minutes with no acknowledgement at all, a "Not confirmed" warning appears on it (Messages, Archive, and the message view) so a send that silently never reached anyone doesn't just look identical to one that did.

## 1.5.2

- Fix: assigning a buyer name via Edit to a draft that was originally imported with no buyer name (so it never had a "Regards," line to begin with) saved the buyer name to the database but never added a signature to the actual message text. The Edit form now appends a fresh signature in that case, instead of only ever updating one that already existed.

## 1.5.1

- Fix: a phone number that isn't actually a registered WhatsApp account previously still showed "Sent" (WhatsApp Web accepted the send locally without a valid destination) - the app now checks with WhatsApp before sending and fails clearly instead, so "Sent" always means it really reached a real account.
- Fix: editing a draft's Broker Name or Buyer Name in the Edit form updated those fields but left the message text's greeting/signature unchanged, so a message could go out reading "Dear ," or "Regards," with nothing filled in even though the form showed the correct names. The message text now updates live as you type those two fields (only when it still looks like this app's own generated wording - a hand-customized message is never silently overwritten).
- Fix: a demand with no buyer name ended with a dangling "Regards," and nothing after it; the signature line is now left out entirely when there's no buyer name, for every new import going forward.
- Redesign the Column Mapping table for clarity: bigger text, more row spacing, row hover highlighting, and a custom-styled dropdown arrow replacing the small native browser one. The Setup Wizard's dialog is now wide enough that this table no longer gets clipped inside it.
- Fix: the app's main content area left large unused margins on wide screens, and a short sidebar left a stark empty gap next to a long table; both now use the available width and height properly.
- Log the actual WhatsApp disconnect reason to `server.log` so a future disconnect is diagnosable instead of only ever showing as a brief status flicker on the dashboard.

## 1.5.0

- Add a new **Archive** page in the sidebar. Uploading a new workbook now moves every row from earlier imports there automatically (whatever its status), so the main Messages list always shows only the latest import. Sending a message also moves it to Archive immediately. Archived rows stay fully viewable, editable, and sendable.
- Fix: a row with no broker name in the source sheet previously discarded the entire generated message, sending a bare placeholder instead of the real demand; the full party/stone/buyer details are now always kept, with only the greeting left blank until a broker is assigned.
- Fix: WhatsApp disconnecting for any reason other than an explicit phone-initiated logout (a brief connection hiccup, network blip, etc.) previously demanded an immediate manual re-link; it now retries a silent reconnect automatically first, falling back to a manual re-link only if that doesn't recover.
- "Send all drafts" no longer resurrects a stale batch already swept into Archive by a newer import; the per-row Send/Retry action on an archived row is unaffected.
- An import sweeping an unresolved failed/needs-verification row into Archive (rather than that row being resolved) is now surfaced as a small badge on the Archive sidebar item, so it's never silently lost.
- Register the new flows (`DRAFT-005`, `WA-007`, `ARCHIVE-001`, `ARCHIVE-002`) in `docs/FEATURE_FLOWS.md`.

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
