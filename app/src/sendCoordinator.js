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

async function coordinateMessageSends(ids, whatsappService, options) {
  const store = options?.store;
  const notifyUpdate = options?.notifyUpdate || (() => {});
  const validateAttachment = options?.validateAttachment || (() => ({ ok: true }));
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
      const recorded = await store.markFailed(id, message);
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
      const recorded = await store.markSent(id, waMessageId);
      if (!recorded) {
        await store.markSendUncertain?.(id, 'WhatsApp accepted the send, but its final result could not be committed. Verify delivery before retrying.');
        results.push({
          id,
          ok: false,
          uncertain: true,
          error: 'WhatsApp accepted the send, but its final result could not be recorded. Verify delivery before retrying.',
        });
      } else {
        results.push({ id, ok: true, waMessageId: waMessageId || null });
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
