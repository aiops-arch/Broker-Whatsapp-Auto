# Architecture

## Overview

Broker Demand Desk is a local, single-PC application with a browser dashboard. The installer bundles Node.js and Chromium so the target department does not need a development environment.

```text
Excel workbook
      |
      v
Import isolation and validation
      |
      v
Embedded SQLite database <---- local broker directory
      |
      v
Operator review in browser dashboard
      |
      v
Send coordinator ----> WhatsApp provider ----> Linked department account
      |
      v
Delivery/uncertainty tracking

SQLite database ----> scheduled/manual backup ----> selected YYYY/MM folder
```

## Main components

### Launcher and watchdog

`start.ps1` establishes installation-scoped runtime configuration, prevents duplicate instances, validates the local port, launches the bundled server and opens the dashboard. It distinguishes this app from unrelated software occupying the same port and can recover from a stopped local process.

`stop.ps1` performs bounded cooperative shutdown and contains forced cleanup to processes owned by the current installation.

### HTTP server

`app/src/server.js` exposes loopback-only JSON endpoints, static dashboard assets, authentication, workbook upload, broker management, message actions, WhatsApp setup, backup configuration and server-sent events.

### Database

`app/src/db.js` uses Node's embedded SQLite support. It owns broker records, message logs, application settings and safe send-state transitions.

`app/src/sqliteSessionStore.js` persists dashboard sessions so a watchdog restart does not force an immediate login. Sessions use a rolling 30-minute idle timeout.

### Import pipeline

`importFiles.js`, `excelParser.js` and `watcher.js` isolate incoming content, enforce file/name/size policies, validate the XLSX structure and schema, quarantine failures and create local drafts.

### Send coordinator

`sendCoordinator.js` and `watcher.js` atomically claim rows before sending. Interrupted sends become uncertain rather than retryable, preventing silent duplicate delivery.

### WhatsApp providers

- `whatsappWeb.js` manages a local `whatsapp-web.js`/Chromium session, phone/QR setup, bounded recovery, send pacing and delivery acknowledgements.
- `whatsappCloudApi.js` contains the official Meta Cloud API provider contract for deployments configured to use it.
- `providers/index.js` selects the provider from installation-scoped configuration.

### Backup manager

`backup.js` validates a writable target, performs SQLite-safe snapshots, creates `YYYY/MM` folders, schedules each PC's chosen local time, catches up one missed boundary and retries failed scheduled backups after 15 minutes.

### Browser dashboard

The dashboard is plain HTML, CSS and JavaScript in `app/public/`. It uses server-sent events plus a coalesced polling fallback. Status revisions prevent stale asynchronous responses from repainting newer WhatsApp state.

## Trust boundaries

- The server listens only on loopback unless explicitly changed for diagnostics.
- Browser/API authentication is required after first-run password creation.
- Uploaded filenames and workbook contents are untrusted.
- Attachment paths are constrained to the local attachment directory.
- WhatsApp/browser events are untrusted asynchronous inputs and cannot be allowed to terminate the process.
- Each department's database and WhatsApp profile are isolated by installation path.

## Persistence

The installer excludes operational directories during upgrades. Application binaries are replaced, while databases, WhatsApp profiles, workbooks, attachments and logs remain on the device.

The repository intentionally excludes all live operational state.

