const express = require('express');
const messageConfig = require('./messageConfig');
const { operatorMessage } = require('./importFiles');

// Builds the /api/config/* routes as their own router so they can be
// mounted by the real server (behind its authenticated /api middleware) and
// exercised directly in tests without needing the full app (WhatsApp
// provider, session store, watcher, etc.) running.
function createConfigRouter({ upload, fs }) {
  const router = express.Router();

  router.get('/mapping', async (req, res) => {
    res.json({ fields: await messageConfig.getFieldMapping() });
  });

  // Read-only defaults, used by Settings/Setup Wizard "Reset to default"
  // actions - never persisted until the operator explicitly saves them.
  router.get('/mapping/default', (req, res) => {
    res.json({ fields: messageConfig.getDefaultFieldMapping() });
  });

  router.get('/template/default', (req, res) => {
    res.json(messageConfig.getDefaultMessageTemplate());
  });

  router.put('/mapping', async (req, res) => {
    try {
      const fields = await messageConfig.setFieldMapping(req.body?.fields);
      res.json({ ok: true, fields });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'Could not save the column mapping.',
        code: error.code || 'FIELD_MAPPING_SAVE_FAILED',
        fieldErrors: error.fieldErrors || [],
      });
    }
  });

  router.get('/template', async (req, res) => {
    res.json(await messageConfig.getMessageTemplate());
  });

  router.put('/template', async (req, res) => {
    try {
      const template = await messageConfig.setMessageTemplate(req.body);
      res.json({ ok: true, ...template });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'Could not save the message template.',
        code: error.code || 'MESSAGE_TEMPLATE_SAVE_FAILED',
      });
    }
  });

  router.post('/template/preview', async (req, res) => {
    try {
      const fields = await messageConfig.getFieldMapping();
      const message = messageConfig.renderPreviewMessage(fields, {
        headerTemplate: req.body?.headerTemplate,
        lineItemTemplate: req.body?.lineItemTemplate,
        buyerLineTemplate: req.body?.buyerLineTemplate,
        lineItemSeparator: req.body?.lineItemSeparator,
      });
      res.json({ ok: true, message });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'Could not render a preview with this template.',
        code: error.code || 'TEMPLATE_PREVIEW_FAILED',
      });
    }
  });

  router.post('/detect-headers', (req, res) => {
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        return res.status(uploadError.statusCode || 400).json({
          error: operatorMessage(uploadError),
          code: uploadError.code || 'UPLOAD_REJECTED',
        });
      }
      if (!req.file) return res.status(400).json({ error: 'Choose one .xlsx workbook to detect its columns.', code: 'FILE_REQUIRED' });
      try {
        const headers = await messageConfig.detectHeaders(req.file.path);
        res.json({ ok: true, headers });
      } catch (error) {
        res.status(error.statusCode || 500).json({
          error: operatorMessage(error),
          code: error.code || 'HEADER_DETECTION_FAILED',
        });
      } finally {
        fs.unlink(req.file.path, () => {});
      }
    });
    return undefined;
  });

  router.get('/onboarding', async (req, res) => {
    res.json({ completed: await messageConfig.getOnboardingCompleted() });
  });

  router.put('/onboarding', async (req, res) => {
    const completed = await messageConfig.setOnboardingCompleted(req.body?.completed !== false);
    res.json({ ok: true, completed });
  });

  router.get('/auto-send', async (req, res) => {
    res.json({ enabled: await messageConfig.getAutoSendEnabled() });
  });

  router.put('/auto-send', async (req, res) => {
    const enabled = await messageConfig.setAutoSendEnabled(req.body?.enabled === true);
    res.json({ ok: true, enabled });
  });

  return router;
}

module.exports = { createConfigRouter };
