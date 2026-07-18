function normalizeMessageIds(ids) {
  const unique = new Set();
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = Number(rawId);
    if (Number.isSafeInteger(id) && id > 0) unique.add(id);
  }
  return [...unique];
}

function blockedStatusMessage(row) {
  if (!row) return 'Message not found.';
  switch (row.status) {
    case 'sent':
      return 'This message was already sent and will not be sent again.';
    case 'sending':
      return 'A send is already in progress for this message.';
    case 'send_uncertain':
      return 'The previous send was interrupted and may already have reached WhatsApp. Verify delivery before taking any further action.';
    case 'needs_info':
      return row.error || 'This message still needs information before it can be sent.';
    default:
      return `This message cannot be sent while its status is "${row.status || 'unknown'}".`;
  }
}

function normalizeConfirmedIds(confirmedIds) {
  if (confirmedIds instanceof Set) return confirmedIds;
  return new Set(Array.isArray(confirmedIds) ? confirmedIds.map(Number) : []);
}

async function coordinateMessageSends(ids, whatsappService, options) {
  const store = options?.store;
  const rawNotifyUpdate = options?.notifyUpdate || (() => {});
  // A throwing listener (e.g. a half-closed SSE response) must never abort
  // the remaining ids in a batch - it's a side effect, not part of the state
  // machine.
  const notifyUpdate = () => {
    try {
      rawNotifyUpdate();
    } catch (error) {
      console.error('[sendCoordinator] a notifyUpdate listener threw and was contained:', error?.message || error);
    }
  };
  const validateAttachment = options?.validateAttachment || (() => ({ ok: true }));
  // Only the single-row Send/Retry routes ever populate this, after the
  // operator has explicitly confirmed a duplicate-flagged row. Bulk sends and
  // auto-send never do, so a flagged row can only ever go out through its own
  // explicit, confirmed action.
  const confirmedIds = normalizeConfirmedIds(options?.confirmedIds);
  const auto = options?.auto === true;
  if (!store) throw new Error('A message store is required.');

  const uniqueIds = normalizeMessageIds(ids);
  const results = [];

  // Not connected is a precondition failure, not a send attempt. No row is
  // claimed and no state is changed.
  if (!whatsappService.isReady || !whatsappService.isReady()) {
    const label = whatsappService.getStatus?.().label || 'WhatsApp';
    for (const id of uniqueIds) {
      results.push({
        id,
        ok: false,
        blocked: true,
        error: `${label} is not connected yet - connect it first, nothing was attempted.`,
      });
    }
    return results;
  }

  for (const id of uniqueIds) {
    const row = await store.getMessage(id);
    if (!row) {
      results.push({ id, ok: false, blocked: true, error: 'Message not found.' });
      continue;
    }
    if (!row.phone || !row.broker_name || row.broker_name === '(unassigned)') {
      results.push({ id, ok: false, blocked: true, error: 'Missing broker or phone - edit this message first.' });
      continue;
    }
    if (row.status !== 'draft' && row.status !== 'failed') {
      results.push({ id, ok: false, blocked: true, uncertain: row.status === 'send_uncertain', error: blockedStatusMessage(row) });
      continue;
    }

    // A possible duplicate (same party/stones already sent or queued to this
    // same phone number from a different import) must never go out silently.
    if (row.duplicate_of_id && !confirmedIds.has(id)) {
      results.push({
        id,
        ok: false,
        blocked: true,
        duplicate: true,
        duplicateOfId: row.duplicate_of_id,
        error: `Possible duplicate of message #${row.duplicate_of_id} (same party/stones already sent or queued to this number) - confirm to send anyway.`,
      });
      continue;
    }

    const attachmentCheck = validateAttachment(row.attachment_path, row);
    if (!attachmentCheck?.ok) {
      results.push({ id, ok: false, blocked: true, error: attachmentCheck?.error || 'The attachment could not be validated.' });
      continue;
    }

    // This compare-and-swap is the duplicate-send boundary. Only one caller
    // can move a draft/failed row into `sending`; all competing calls observe
    // the locked state and stop before invoking WhatsApp.
    const claimed = await store.claimMessageForSend(id);
    if (!claimed) {
      const latest = await store.getMessage(id);
      results.push({
        id,
        ok: false,
        blocked: true,
        uncertain: latest?.status === 'send_uncertain',
        error: blockedStatusMessage(latest),
      });
      continue;
    }
    notifyUpdate();

    let waMessageId;
    try {
      waMessageId = await whatsappService.sendMessage(
        claimed.phone,
        claimed.message,
        attachmentCheck.path || claimed.attachment_path,
      );
    } catch (error) {
      const message = error?.message || String(error);
      let recorded = false;
      try {
        recorded = await store.markFailed(id, message);
      } catch (markError) {
        // The send is CERTAIN to have failed (WhatsApp already threw), so a
        // definite failure must never be left mislabeled as "maybe delivered"
        // just because the follow-up DB write itself failed. Try to at least
        // land it as send_uncertain instead of silently leaving `sending`.
        console.error('[sendCoordinator] markFailed itself failed:', markError?.message || markError);
        try {
          await store.markSendUncertain(id, 'WhatsApp reported a send failure, but it could not be recorded safely. Verify delivery before taking further action.');
        } catch (_) {
          // Leaving `sending` in the DB is itself fail-safe: init() converts
          // it to send_uncertain after an interrupted process and it is not
          // claimable in the meantime.
        }
      }
      if (!recorded) {
        results.push({
          id,
          ok: false,
          uncertain: true,
          error: 'WhatsApp returned an error, but the result could not be recorded safely. Verify delivery before retrying.',
        });
      } else {
        results.push({ id, ok: false, error: message });
      }
      notifyUpdate();
      continue;
    }

    try {
      const recorded = await store.markSent(id, waMessageId, { auto });
      if (!recorded) {
        await store.markSendUncertain?.(id, 'WhatsApp accepted the send, but its final result could not be committed. Verify delivery before retrying.');
        results.push({
          id,
          ok: false,
          uncertain: true,
          error: 'WhatsApp accepted the send, but its final result could not be recorded. Verify delivery before retrying.',
        });
      } else {
        results.push({ id, ok: true, waMessageId: waMessageId || null, auto });
      }
    } catch (error) {
      // Never turn a post-send database failure into a retryable `failed`
      // row: WhatsApp may already have delivered it.
      try {
        await store.markSendUncertain?.(id, 'WhatsApp accepted the send, but its final result could not be committed. Verify delivery before retrying.');
      } catch (recordError) {
        // Leaving `sending` in the DB is itself fail-safe: init() converts it
        // to send_uncertain after an interrupted process and it is not claimable.
      }
      results.push({
        id,
        ok: false,
        uncertain: true,
        error: 'WhatsApp accepted the send, but its final result could not be recorded. Verify delivery before retrying.',
      });
    }
    notifyUpdate();
  }

  return results;
}

module.exports = {
  normalizeMessageIds,
  blockedStatusMessage,
  coordinateMessageSends,
};
