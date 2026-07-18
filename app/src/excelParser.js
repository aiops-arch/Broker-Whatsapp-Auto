const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const messageConfig = require('./messageConfig');
const { normalizeHeader, cellText, formatCts, workbookError, assertRealXlsxFile } = require('./workbookUtils');

function fieldValue(field, raw) {
  if (field.format === 'decimal2') return formatCts(raw);
  return cellText(raw);
}

// Reads the dropped workbook using this installation's configured column
// mapping and message template (see messageConfig.js), and groups rows into
// one message per configured group-role field combination (Broker Name +
// whichever fields are marked "group", by default Party Name + Demand Date).
async function parseWorkbook(filePath) {
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

  const fields = await messageConfig.getFieldMapping();
  const template = await messageConfig.getMessageTemplate();

  const brokerNameField = fields.find((f) => f.role === 'broker_name');
  if (!brokerNameField) {
    throw workbookError('MISSING_BROKER_NAME_FIELD', 'Column mapping needs exactly one broker name field. Fix this in Settings before importing.');
  }
  const brokerPhoneField = fields.find((f) => f.role === 'broker_phone');
  const attachmentField = fields.find((f) => f.role === 'attachment');
  const groupFields = fields.filter((f) => f.role === 'group');
  const primaryGroupField = groupFields.find((f) => f.primaryGroupField) || groupFields[0];
  const dateField = groupFields.find((f) => f.dateField);
  const otherGroupFields = groupFields.filter((f) => f !== primaryGroupField && f !== dateField);
  const headerFields = fields.filter((f) => f.role === 'header');
  const buyerField = headerFields.find((f) => f.buyerField);
  const lineFields = fields.filter((f) => f.role === 'line');
  const dedupLineFields = lineFields.filter((f) => f.dedupComponent);

  const headerLookup = new Map(fields.map((f) => [normalizeHeader(f.sourceHeader), f]));

  const headerRow = ws.getRow(1);
  const colIndexToField = {};
  const foundKeys = new Set();
  const duplicateKeys = new Set();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = normalizeHeader(cellText(cell.value));
    const field = headerLookup.get(key);
    if (!field) return;
    if (foundKeys.has(field.key)) duplicateKeys.add(field.key);
    foundKeys.add(field.key);
    colIndexToField[colNumber] = field;
  });

  if (duplicateKeys.size > 0) {
    const labels = [...duplicateKeys].map((key) => fields.find((f) => f.key === key)?.label || key);
    throw workbookError('DUPLICATE_WORKBOOK_HEADERS', `The header row contains duplicate columns: ${labels.join(', ')}.`);
  }

  const missingHeaders = fields
    .filter((f) => f.requiredHeader && !foundKeys.has(f.key))
    .map((f) => f.label || f.sourceHeader);
  if (missingHeaders.length > 0) {
    throw workbookError('MISSING_REQUIRED_HEADERS', `Required columns are missing: ${missingHeaders.join(', ')}.`);
  }

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.cellCount === 0) continue;
    const rec = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const field = colIndexToField[colNumber];
      if (field) rec[field.key] = cell.value;
    });
    const hasMappedContent = Object.values(rec).some((value) => cellText(value) !== '');
    if (!hasMappedContent) continue;

    const missingValues = fields
      .filter((f) => f.requiredRow && cellText(rec[f.key]) === '')
      .map((f) => f.label || f.sourceHeader);
    if (missingValues.length > 0) {
      throw workbookError('MALFORMED_DATA_ROW', `Row ${r} is missing required values: ${missingValues.join(', ')}.`);
    }

    const values = {};
    for (const f of fields) values[f.key] = fieldValue(f, rec[f.key]);
    rows.push(values);
  }

  if (rows.length === 0) {
    throw workbookError('NO_DATA_ROWS', 'The workbook has the correct headers but contains no demand rows.');
  }

  // Group by broker + the configured group-role fields (by default Party
  // Name + Demand Date), same grouping semantics as the original fixed
  // implementation but driven by whatever fields are marked "group" now.
  const groups = new Map();
  for (const values of rows) {
    const groupFieldValues = {};
    for (const f of groupFields) groupFieldValues[f.key] = values[f.key];
    const otherGroupKeyParts = otherGroupFields.map((f) => values[f.key]);
    const groupKey = [
      values[brokerNameField.key],
      groupFieldValues[primaryGroupField.key],
      dateField ? groupFieldValues[dateField.key] : '',
      ...otherGroupKeyParts,
    ].join('||');

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        brokerName: values[brokerNameField.key],
        groupFieldValues,
        phoneFromSheet: brokerPhoneField ? (values[brokerPhoneField.key] || null) : null,
        headerValues: {},
        lineRows: [],
      });
    }
    const group = groups.get(groupKey);
    for (const f of headerFields) {
      if (!group.headerValues[f.key] && values[f.key]) group.headerValues[f.key] = values[f.key];
    }
    if (attachmentField && !group.headerValues[attachmentField.key] && values[attachmentField.key]) {
      group.headerValues[attachmentField.key] = values[attachmentField.key];
    }
    group.lineRows.push(values);
  }

  const results = [];
  for (const g of groups.values()) {
    const brokerName = g.brokerName;

    const data = { [brokerNameField.key]: brokerName };
    if (brokerPhoneField) data[brokerPhoneField.key] = g.phoneFromSheet || '';
    Object.assign(data, g.groupFieldValues);
    for (const f of headerFields) data[f.key] = g.headerValues[f.key] || '';

    const lineItems = g.lineRows
      .map((rowValues, i) => {
        const lineData = { index: i + 1 };
        for (const f of lineFields) lineData[f.key] = rowValues[f.key];
        return messageConfig.renderTemplate(template.lineItemTemplate, lineData);
      })
      .join(template.lineItemSeparator != null ? template.lineItemSeparator : '\n');
    data.lineItems = lineItems;
    data.buyerLine = (buyerField && g.headerValues[buyerField.key])
      ? messageConfig.renderTemplate(template.buyerLineTemplate, data)
      : '';

    // Always render the full message - even when the broker name is blank,
    // so the real party/stone/buyer details are never silently discarded.
    // {{brokerName}} just renders as an empty string via renderTemplate's
    // existing null/empty fallback, producing an honest blank greeting
    // ("Dear ,") rather than losing all the demand details it took to
    // compute. An operator assigning a broker later via Edit only needs to
    // fix the greeting line, never reconstruct the whole message by hand.
    const message = messageConfig.renderTemplate(template.headerTemplate, data);

    const perRowDedup = g.lineRows
      .map((rowValues) => dedupLineFields.map((f) => rowValues[f.key]).join('|'))
      .sort()
      .join(',');
    const dedupParts = [
      brokerName,
      g.groupFieldValues[primaryGroupField.key],
      dateField ? g.groupFieldValues[dateField.key] : '',
      ...otherGroupFields.map((f) => g.groupFieldValues[f.key]),
      perRowDedup,
    ];
    const dedupKey = crypto.createHash('sha256').update(dedupParts.join('|')).digest('hex');

    results.push({
      brokerName,
      partyName: g.groupFieldValues[primaryGroupField.key],
      demandDate: dateField ? g.groupFieldValues[dateField.key] : '',
      phoneFromSheet: g.phoneFromSheet,
      buyerName: buyerField ? (g.headerValues[buyerField.key] || null) : null,
      attachmentFile: attachmentField ? (g.headerValues[attachmentField.key] || null) : null,
      stoneCount: g.lineRows.length,
      message,
      dedupKey,
      // Same sorted dedup-component values used above, but WITHOUT the
      // broker/date baked in - lets db.js detect a "possible duplicate" for
      // the same party+stones reaching the same phone from a DIFFERENT
      // import/file, which dedupKey alone cannot do.
      dedupComponentSignature: perRowDedup,
    });
  }

  return results;
}

module.exports = { parseWorkbook };
