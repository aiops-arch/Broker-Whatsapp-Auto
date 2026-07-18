const ExcelJS = require('exceljs');
const db = require('./db');
const { normalizeHeader, cellText, workbookError, assertRealXlsxFile } = require('./workbookUtils');

const FIELD_MAPPING_SETTING_KEY = 'field_mapping_config_v1';
const MESSAGE_TEMPLATE_SETTING_KEY = 'message_template_config_v1';
const ONBOARDING_SETTING_KEY = 'setup_wizard_completed';
const AUTO_SEND_SETTING_KEY = 'auto_send_enabled';

const VALID_ROLES = Object.freeze([
  'broker_name', 'broker_phone', 'group', 'header', 'line', 'attachment', 'ignore',
]);

// Computed placeholders the renderer fills in itself - not backed by a
// mapped column, so they are always allowed in templates regardless of
// what the operator has configured.
const RESERVED_TEMPLATE_KEYS = Object.freeze(['buyerLine', 'lineItems']);
const RESERVED_LINE_TEMPLATE_KEYS = Object.freeze(['index']);

const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function configError(code, message, fieldErrors) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  if (fieldErrors) error.fieldErrors = fieldErrors;
  return error;
}

// This mapping and template combination reproduces the application's
// original fixed behavior byte-for-byte. Existing installations upgrading
// from an earlier release see it seeded automatically on first read, so
// nothing changes until an operator deliberately edits Settings.
function getDefaultFieldMapping() {
  return [
    { key: 'invoiceNo', label: 'Invoice No.', sourceHeader: 'Invoice No.', role: 'ignore', requiredHeader: true, requiredRow: false },
    {
      key: 'demandDate', label: 'Demand Date', sourceHeader: 'Demand Date', role: 'group',
      requiredHeader: true, requiredRow: true, dateField: true, dedupComponent: true,
    },
    {
      key: 'partyName', label: 'Party Name', sourceHeader: 'Party Name', role: 'group',
      requiredHeader: true, requiredRow: true, primaryGroupField: true, dedupComponent: true,
    },
    {
      key: 'stoneId', label: 'Stone ID', sourceHeader: 'StoneId', role: 'line',
      requiredHeader: true, requiredRow: true, dedupComponent: true,
    },
    { key: 'reportNo', label: 'Report No.', sourceHeader: 'ReportNo.', role: 'line', requiredHeader: true, requiredRow: false },
    { key: 'color', label: 'Color', sourceHeader: 'Color', role: 'line', requiredHeader: true, requiredRow: false },
    { key: 'clarity', label: 'Clarity', sourceHeader: 'Clarity', role: 'line', requiredHeader: true, requiredRow: false },
    {
      key: 'cts', label: 'CTS', sourceHeader: 'CTS', role: 'line',
      requiredHeader: true, requiredRow: false, format: 'decimal2',
    },
    { key: 'brokerName', label: 'Broker Name', sourceHeader: 'Broker Name', role: 'broker_name', requiredHeader: true, requiredRow: false },
    {
      key: 'brokerPhone', label: 'Broker Contact Number', sourceHeader: 'Broker Contact Number', role: 'broker_phone',
      requiredHeader: true, requiredRow: false,
    },
    {
      key: 'buyerName', label: 'Buyer Name', sourceHeader: 'Buyer Name', role: 'header',
      requiredHeader: false, requiredRow: false, buyerField: true,
    },
    { key: 'attachmentFile', label: 'Attachment', sourceHeader: 'Attachment', role: 'attachment', requiredHeader: false, requiredRow: false },
  ];
}

function getDefaultMessageTemplate() {
  return {
    headerTemplate: "Dear {{brokerName}},\n\nPlease find today's demand:\n\nParty Name: {{partyName}}\n{{lineItems}}\n\nRegards,\n{{buyerName}}",
    lineItemTemplate: '{{index}}) StoneId: {{stoneId}} | Report#: {{reportNo}} | Color: {{color}} | Clarity: {{clarity}} | Cts: {{cts}}',
    buyerLineTemplate: '',
    lineItemSeparator: '\n',
  };
}

function validateFieldMapping(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw configError('EMPTY_FIELD_MAPPING', 'Add at least one mapped column before saving.');
  }

  const fieldErrors = [];
  const seenKeys = new Set();
  const seenHeaders = new Set();
  let brokerNameCount = 0;
  let brokerPhoneCount = 0;
  let attachmentCount = 0;
  let groupCount = 0;
  let primaryGroupCount = 0;
  let dateFieldCount = 0;
  let buyerFieldCount = 0;

  for (const field of fields) {
    const key = String(field?.key || '').trim();
    const sourceHeader = String(field?.sourceHeader || '').trim();
    const role = field?.role;

    if (!KEY_PATTERN.test(key)) {
      fieldErrors.push({ key: key || null, message: 'Field key must start with a letter or underscore and contain only letters, numbers, or underscores.' });
    } else if (seenKeys.has(key)) {
      fieldErrors.push({ key, message: `Field key "${key}" is used more than once.` });
    } else {
      seenKeys.add(key);
    }

    if (!sourceHeader) {
      fieldErrors.push({ key, message: 'Choose the column name from your workbook for this field.' });
    } else {
      const normalized = normalizeHeader(sourceHeader);
      if (seenHeaders.has(normalized)) {
        fieldErrors.push({ key, message: `Column name "${sourceHeader}" is mapped more than once.` });
      } else {
        seenHeaders.add(normalized);
      }
    }

    if (!VALID_ROLES.includes(role)) {
      fieldErrors.push({ key, message: `"${role}" is not a supported field role.` });
      continue;
    }

    if (role === 'broker_name') brokerNameCount += 1;
    if (role === 'broker_phone') brokerPhoneCount += 1;
    if (role === 'attachment') attachmentCount += 1;
    if (role === 'group') {
      groupCount += 1;
      if (field.primaryGroupField) primaryGroupCount += 1;
      if (field.dateField) dateFieldCount += 1;
    }
    if (role === 'header' && field.buyerField) buyerFieldCount += 1;
  }

  if (brokerNameCount !== 1) {
    fieldErrors.push({ key: null, message: 'Exactly one field must be marked as the broker name.' });
  }
  if (brokerPhoneCount > 1) {
    fieldErrors.push({ key: null, message: 'Only one field can be marked as the broker phone number.' });
  }
  if (attachmentCount > 1) {
    fieldErrors.push({ key: null, message: 'Only one field can be marked as the attachment column.' });
  }
  if (groupCount < 1) {
    fieldErrors.push({ key: null, message: 'At least one field must be used to group rows into a message.' });
  }
  if (primaryGroupCount !== 1) {
    fieldErrors.push({ key: null, message: 'Exactly one grouping field must be marked as the primary group field (e.g. Party Name).' });
  }
  if (dateFieldCount > 1) {
    fieldErrors.push({ key: null, message: 'Only one grouping field can be marked as the date field.' });
  }
  if (buyerFieldCount > 1) {
    fieldErrors.push({ key: null, message: 'Only one field can be marked as the buyer field.' });
  }

  if (fieldErrors.length > 0) {
    throw configError('INVALID_FIELD_MAPPING', 'The column mapping has one or more problems. Fix the highlighted fields and try again.', fieldErrors);
  }
}

function extractPlaceholders(str) {
  return [...String(str || '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
}

function validateMessageTemplate(template, fields) {
  if (!template || typeof template !== 'object') {
    throw configError('INVALID_MESSAGE_TEMPLATE', 'A message template is required.');
  }
  const headerTemplate = String(template.headerTemplate || '');
  const lineItemTemplate = String(template.lineItemTemplate || '');
  const buyerLineTemplate = String(template.buyerLineTemplate || '');

  if (!headerTemplate.trim()) {
    throw configError('INVALID_MESSAGE_TEMPLATE', 'The message template cannot be empty.');
  }
  if (!lineItemTemplate.trim()) {
    throw configError('INVALID_MESSAGE_TEMPLATE', 'The line item template cannot be empty.');
  }
  if (!headerTemplate.includes('{{lineItems}}')) {
    throw configError('MISSING_LINE_ITEMS_PLACEHOLDER', 'The message template must include {{lineItems}} so stone/line details appear in the message.');
  }

  const fieldList = Array.isArray(fields) ? fields : [];
  const headerAllowed = new Set([
    ...fieldList.filter((f) => ['broker_name', 'broker_phone', 'group', 'header'].includes(f.role)).map((f) => f.key),
    ...RESERVED_TEMPLATE_KEYS,
  ]);
  const lineAllowed = new Set([
    ...fieldList.filter((f) => f.role === 'line').map((f) => f.key),
    ...RESERVED_LINE_TEMPLATE_KEYS,
  ]);

  const unknownHeaderTokens = [...new Set([
    ...extractPlaceholders(headerTemplate),
    ...extractPlaceholders(buyerLineTemplate),
  ])].filter((token) => !headerAllowed.has(token));
  if (unknownHeaderTokens.length > 0) {
    throw configError(
      'UNKNOWN_TEMPLATE_PLACEHOLDER',
      `Unknown placeholder(s) in the message template: ${unknownHeaderTokens.map((t) => `{{${t}}}`).join(', ')}.`,
    );
  }

  const unknownLineTokens = [...new Set(extractPlaceholders(lineItemTemplate))].filter((token) => !lineAllowed.has(token));
  if (unknownLineTokens.length > 0) {
    throw configError(
      'UNKNOWN_TEMPLATE_PLACEHOLDER',
      `Unknown placeholder(s) in the line item template: ${unknownLineTokens.map((t) => `{{${t}}}`).join(', ')}.`,
    );
  }
}

// Deliberately a plain regex substitution - never eval()/Function() - so a
// user-supplied template can never execute code, even if a mapped value
// happens to contain `${...}` or backtick-like text.
function renderTemplate(templateString, data) {
  return String(templateString || '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = data ? data[key] : undefined;
    return value != null ? String(value) : '';
  });
}

function sampleLabel(field) {
  return field.label || field.key;
}

// Renders an illustrative example message from synthetic sample data, for
// the Setup Wizard/Settings live preview. Works with any user-chosen field
// keys/labels since it never assumes today's specific default names.
function renderPreviewMessage(fields, template) {
  const fieldList = Array.isArray(fields) ? fields : [];
  const brokerNameField = fieldList.find((f) => f.role === 'broker_name');
  if (!brokerNameField) {
    throw configError('MISSING_BROKER_NAME_FIELD', 'Column mapping needs exactly one broker name field before a preview can be generated.');
  }
  const brokerPhoneField = fieldList.find((f) => f.role === 'broker_phone');
  const groupFields = fieldList.filter((f) => f.role === 'group');
  const dateField = groupFields.find((f) => f.dateField);
  const headerFields = fieldList.filter((f) => f.role === 'header');
  const buyerField = headerFields.find((f) => f.buyerField);
  const lineFields = fieldList.filter((f) => f.role === 'line');

  const sampleFor = (field, index) => {
    if (field.format === 'decimal2') return (1.2 + index * 0.35).toFixed(2);
    if (field === dateField) return '2026-01-15';
    return `Sample ${sampleLabel(field)}`;
  };

  const data = { [brokerNameField.key]: 'Sample Broker' };
  if (brokerPhoneField) data[brokerPhoneField.key] = '+91 90000 00000';
  for (const f of groupFields) data[f.key] = sampleFor(f, 0);
  for (const f of headerFields) data[f.key] = sampleFor(f, 0);

  const separator = template.lineItemSeparator != null ? template.lineItemSeparator : '\n';
  const lineItems = Array.from({ length: 2 }, (_, i) => {
    const lineData = { index: i + 1 };
    for (const f of lineFields) lineData[f.key] = sampleFor(f, i);
    return renderTemplate(template.lineItemTemplate, lineData);
  }).join(separator);
  data.lineItems = lineItems;
  data.buyerLine = buyerField ? renderTemplate(template.buyerLineTemplate, data) : '';

  return renderTemplate(template.headerTemplate, data);
}

async function getFieldMapping() {
  const raw = await db.getSetting(FIELD_MAPPING_SETTING_KEY);
  if (!raw) {
    const defaults = getDefaultFieldMapping();
    await db.setSetting(FIELD_MAPPING_SETTING_KEY, JSON.stringify(defaults));
    return defaults;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (error) {
    // fall through to defaults below - a corrupted setting must never break imports
  }
  return getDefaultFieldMapping();
}

async function setFieldMapping(fields) {
  validateFieldMapping(fields);
  await db.setSetting(FIELD_MAPPING_SETTING_KEY, JSON.stringify(fields));
  return fields;
}

async function getMessageTemplate() {
  const raw = await db.getSetting(MESSAGE_TEMPLATE_SETTING_KEY);
  if (!raw) {
    const defaults = getDefaultMessageTemplate();
    await db.setSetting(MESSAGE_TEMPLATE_SETTING_KEY, JSON.stringify(defaults));
    return defaults;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    // fall through to defaults below
  }
  return getDefaultMessageTemplate();
}

async function setMessageTemplate(template) {
  const fields = await getFieldMapping();
  validateMessageTemplate(template, fields);
  await db.setSetting(MESSAGE_TEMPLATE_SETTING_KEY, JSON.stringify(template));
  return template;
}

async function getOnboardingCompleted() {
  const raw = await db.getSetting(ONBOARDING_SETTING_KEY);
  return raw === 'true';
}

async function setOnboardingCompleted(completed) {
  const value = completed === true;
  await db.setSetting(ONBOARDING_SETTING_KEY, value ? 'true' : 'false');
  return value;
}

// Off by default. When on, a just-completed import's own complete,
// non-duplicate-flagged rows send automatically - see watcher.js's
// ingestFile. Never affects older drafts already sitting in the queue.
async function getAutoSendEnabled() {
  return (await db.getSetting(AUTO_SEND_SETTING_KEY)) === 'true';
}

async function setAutoSendEnabled(enabled) {
  const value = enabled === true;
  await db.setSetting(AUTO_SEND_SETTING_KEY, value ? 'true' : 'false');
  return value;
}

// Reads only the header row of a candidate sample workbook - used by the
// Setup Wizard's "auto-detect my columns" step. Does not import any data.
async function detectHeaders(filePath) {
  assertRealXlsxFile(filePath);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch (error) {
    throw workbookError(
      'MALFORMED_XLSX_WORKBOOK',
      'The .xlsx workbook is damaged or cannot be read. Re-save it from Excel and try again.',
      error.message,
    );
  }
  if (wb.worksheets.length === 0) {
    throw workbookError('WORKBOOK_HAS_NO_SHEETS', 'The workbook does not contain a worksheet.');
  }
  const ws = wb.worksheets[0];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    const text = cellText(cell.value);
    if (text) headers.push(text);
  });
  if (headers.length === 0) {
    throw workbookError('NO_HEADER_ROW_FOUND', 'No column headers were found in the first row of this workbook.');
  }
  return headers;
}

module.exports = {
  VALID_ROLES,
  getDefaultFieldMapping,
  getDefaultMessageTemplate,
  getFieldMapping,
  setFieldMapping,
  getMessageTemplate,
  setMessageTemplate,
  validateFieldMapping,
  validateMessageTemplate,
  renderTemplate,
  renderPreviewMessage,
  detectHeaders,
  getOnboardingCompleted,
  setOnboardingCompleted,
  getAutoSendEnabled,
  setAutoSendEnabled,
};
