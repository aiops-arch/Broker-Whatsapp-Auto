# Changelog

## 1.2.5

- Persist dashboard authentication in local SQLite across server/watchdog restarts.
- Use a rolling 30-minute inactivity timeout.
- Contain recoverable WhatsApp/Puppeteer detached-frame navigation races.
- Add a per-PC custom daily backup time with immediate rescheduling.
- Coalesce server-sent events and fallback refreshes to reduce UI lag during sends.
- Add professional card, button, modal and responsive animations.
- Remove mobile page-level horizontal overflow.
- Add persistent-session, custom-schedule and browser-layout verification.

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

