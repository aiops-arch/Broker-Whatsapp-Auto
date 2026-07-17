# Operations and troubleshooting

## Deployment checklist

1. Verify the installer checksum.
2. Install under the Windows account that will operate the application.
3. Create the department-specific dashboard password.
4. Link only that department's WhatsApp account.
5. Select a backup folder accessible to that PC.
6. Set and save the device's required daily backup time.
7. Run **Back up now** and confirm that a non-empty `.db` file appears.
8. Import a controlled test workbook.
9. Review the draft without sending, then perform one approved test send.
10. Confirm the message state and WhatsApp conversation.

## Upgrade checklist

1. Ensure no bulk send is in progress.
2. Run a manual backup.
3. Run the new installer directly over the existing version.
4. Do not uninstall the old version first.
5. Open the app and confirm the product behavior, linked WhatsApp state, broker list, backup folder and device-specific schedule.

## Common issues

### App says it is running but no page opens

- Open `http://127.0.0.1:4173` exactly.
- Check `data/watchdog.log` and `data/server.log` inside the installation directory.
- Confirm no unrelated application owns port 4173.
- Use the Stop shortcut, wait a few seconds, then start the app again.

### WhatsApp repeatedly disconnects or returns to setup

- Install the latest release over the existing installation.
- Do not delete the local WhatsApp profile unless the account is intentionally being relinked.
- Confirm the phone has connectivity and the linked-device entry still exists.
- Review recent server log entries for authentication failure, browser launch timeout or security-software blocking.
- Use **Reset WhatsApp setup** only for an incomplete/broken setup; it refuses to erase a ready account.

### Dashboard asks for the password after a restart

Version 1.2.5 persists sessions across server restarts. Sessions expire after 30 minutes without activity, and are deliberately invalidated by logout, password change or password recovery.

### One `.xlsx` upload is rejected

- Confirm the extension is truly `.xlsx`, not renamed `.xls`.
- Confirm the file is below 10 MB.
- Use the single styled file chooser and select only one workbook.
- Verify the required headers.
- Check `failed-imports` for the retained workbook and its `.error.txt` sidecar.

### Backup folder window appears missing

The chooser is a foreground native Windows dialog. Look for **Broker Demand Desk - Choose backup folder** in the task switcher if another application takes focus.

### Scheduled backup did not run

- Confirm a folder is selected and writable.
- Confirm the time shown in the backup card is correct for that PC.
- Check the displayed next-backup time and last error.
- A failed scheduled backup retries after 15 minutes.
- Use **Back up now** to distinguish scheduling problems from drive/permission problems.

### A row says Verify first

Do not retry immediately. Open the relevant WhatsApp conversation and determine whether the message was delivered. Then use the application's reconciliation action to mark it delivered or explicitly approve one retry.

## Logs

Runtime diagnostics are local to each installation. Logs are rotated and common credential patterns are redacted, but they can still contain business filenames and error context. Share only the minimum lines needed for support.

## Backup recovery

Backups are standard SQLite database snapshots. Before recovery:

1. Stop the app.
2. Preserve the current database separately.
3. Verify the selected snapshot is non-empty and from the intended department/date.
4. Replace data only within the intended installation.
5. Restart and verify counts, brokers and settings before sending anything.

Do not restore one department's database into another department's installation without explicit approval and a migration plan.

