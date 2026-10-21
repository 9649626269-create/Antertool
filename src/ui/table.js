'use strict';

/**
 * Shared Table Renderer.
 * Used across startup initialization, bot lists, proxy lists, system diagnostics,
 * help menus, and the terminal dashboard.
 * Pure rendering functions: (columns, rows, options, caps, theme) -> string[]
 */

const { visibleWidth, truncate, pad, wrap, stripAnsi, sanitizeUntrusted } = require('./text');

function isMissing(val) {
  return val === null || val === undefined || val === '' || (typeof val === 'number' && Number.isNaN(val));
}

function formatCellValue(rawVal, col, caps, theme) {
  if (isMissing(rawVal)) {
    return theme ? theme.muted('-') : '-';
  }
  if (col && typeof col.format === 'function') {
    const formatted = col.format(rawVal, caps, theme);
    if (isMissing(formatted)) return theme ? theme.muted('-') : '-';
    return String(formatted);
  }
  if (col && col.status && theme && typeof theme.formatStatus === 'function') {
    // If already formatted with ANSI, return as-is; otherwise use semantic status formatter
    const str = String(rawVal);
    if (str.includes('\x1b[')) return str;
    return theme.formatStatus(str).text;
  }
  const str = String(rawVal);
  if (str.includes('\x1b[')) return str;
  return sanitizeUntrusted(str);
}

/**
 * Render stacked key-value blocks for narrow terminals (< stackedThreshold or when columns cannot fit).
 */
function renderStackedBlocks(columns, rows, options, caps, theme) {
  const maxWidth = Math.max(20, (caps && caps.width) || 80);
  const ascii = !(caps && caps.unicode);
  const b = (caps && caps.borders) || { horizontal: '-', vertical: '|' };
  const borderFn = theme ? theme.border : (s => s);
  const keyFn = theme ? theme.muted : (s => s);
  const titleFn = theme ? theme.title : (s => s);

  if (!rows || !rows.length) {
    const emptyMsg = options.emptyText || 'No entries.';
    return [truncate(theme ? theme.muted(`  ${emptyMsg}`) : `  ${emptyMsg}`, maxWidth, { ascii })];
  }

  const labelW = Math.min(
    Math.floor(maxWidth * 0.4),
    Math.max(4, ...columns.map(c => visibleWidth(c.label || c.key || '')))
  );
  const valMaxW = Math.max(8, maxWidth - labelW - 5);
  const lines = [];
  const sepWidth = Math.max(10, Math.min(maxWidth, 40));

  rows.forEach((row, idx) => {
    if (idx > 0) {
      lines.push(borderFn(b.horizontal.repeat(sepWidth)));
    }
    for (let cIdx = 0; cIdx < columns.length; cIdx++) {
      const col = columns[cIdx];
      const raw = row && typeof row === 'object' ? row[col.key] : undefined;
      const cellStr = formatCellValue(raw, col, caps, theme);
      const lbl = pad(truncate(String(col.label || col.key || ''), labelW, { ascii }), labelW, 'left');
      const val = truncate(cellStr, valMaxW, { ascii });
      const formattedLbl = cIdx === 0 ? titleFn(lbl) : keyFn(lbl);
      const line = `${borderFn(b.vertical)} ${formattedLbl} : ${val}`;
      lines.push(truncate(line, maxWidth, { ascii }));
    }
  });

  return lines;
}

/**
 * Pure table renderer.
 * @param {Array} columns - [{ key, label, align, minWidth, maxWidth, flex, priority, status, wrap, format }]
 * @param {Array} rows - Array of row objects
 * @param {Object} options - { maxWidth, stackedThreshold, compact, title, emptyText }
 * @param {Object} caps - Terminal capabilities
 * @param {Object} theme - Semantic theme
 * @returns {string[]} Array of formatted lines, each guaranteed <= maxWidth and equal visible width
 */
function renderTable(columns, rows, options = {}, caps = null, theme = null) {
  const termW = Math.max(20, Number(options.maxWidth || (caps && caps.width) || 80));
  const ascii = !(caps && caps.unicode);
  const b = (caps && caps.borders) || {
    topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
    horizontal: '-', vertical: '|', topMid: '+', bottomMid: '+', leftMid: '+', rightMid: '+', midMid: '+',
  };
  const borderFn = theme ? theme.border : (s => s);
  const headerFn = theme ? theme.title : (s => s);

  if (!Array.isArray(columns) || !columns.length) return [];
  const safeRows = Array.isArray(rows) ? rows : [];

  const stackedThreshold = options.stackedThreshold !== undefined ? options.stackedThreshold : 48;
  if (termW < stackedThreshold) {
    return renderStackedBlocks(columns, safeRows, options, caps, theme);
  }

  // Prepare formatted cells for active columns
  let activeCols = columns.map((c, idx) => ({
    ...c,
    _idx: idx,
    label: String(c.label !== undefined ? c.label : c.key),
    align: c.align || (c.numeric ? 'right' : 'left'),
    minWidth: Math.max(2, Number(c.minWidth) || 3),
    maxWidth: Math.max(4, Number(c.maxWidth) || 60),
    priority: c.priority !== undefined ? Number(c.priority) : 1,
    flex: Boolean(c.flex),
  }));

  const computeLayout = (cols) => {
    const colCells = cols.map(col => safeRows.map(r => formatCellValue(r ? r[col.key] : undefined, col, caps, theme)));
    const widths = cols.map((col, i) => {
      const headerW = visibleWidth(col.label);
      const maxCellW = colCells[i].reduce((m, cell) => {
        const lineW = String(cell).split('\n').reduce((lm, l) => Math.max(lm, visibleWidth(l)), 0);
        return Math.max(m, lineW);
      }, 0);
      const natural = Math.max(headerW, maxCellW, col.minWidth);
      return Math.min(col.maxWidth, natural);
    });
    // Border overhead: '│ ' + col0 + ' │ ' + col1 + ' │' => 3 * N + 1
    const overhead = 3 * cols.length + 1;
    const totalW = overhead + widths.reduce((a, w) => a + w, 0);
    return { widths, colCells, overhead, totalW };
  };

  let layout = computeLayout(activeCols);

  // Drop lowest-priority columns (higher priority number = lower importance) if minimum widths exceed termW
  while (activeCols.length > 1) {
    const minPossible = (3 * activeCols.length + 1) + activeCols.reduce((s, c) => s + c.minWidth, 0);
    if (minPossible <= termW && layout.totalW <= termW) break;
    if (minPossible <= termW) {
      // Can fit by shrinking columns without dropping
      break;
    }
    // Find droppable column with highest priority number (> 1 first, otherwise rightmost column)
    let dropIdx = -1;
    let maxPrio = 1;
    for (let i = activeCols.length - 1; i >= 0; i--) {
      if (activeCols[i].priority > maxPrio) {
        maxPrio = activeCols[i].priority;
        dropIdx = i;
      }
    }
    if (dropIdx === -1) {
      dropIdx = activeCols.length - 1;
    }
    activeCols.splice(dropIdx, 1);
    layout = computeLayout(activeCols);
  }

  // Check if even after dropping columns it still cannot fit in termW
  const minTotal = layout.overhead + activeCols.reduce((s, c) => s + c.minWidth, 0);
  if (minTotal > termW) {
    return renderStackedBlocks(columns, safeRows, options, caps, theme);
  }

  // Shrink columns if totalW > termW
  const widths = [...layout.widths];
  let currentTotal = layout.overhead + widths.reduce((a, w) => a + w, 0);

  while (currentTotal > termW) {
    // Shrink flex columns first, or the widest column above its minWidth
    let bestIdx = -1;
    let bestSlack = 0;
    for (let i = 0; i < activeCols.length; i++) {
      const slack = widths[i] - activeCols[i].minWidth;
      const weight = activeCols[i].flex ? slack * 2 : slack;
      if (slack > 0 && weight > bestSlack) {
        bestSlack = weight;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    widths[bestIdx]--;
    currentTotal--;
  }

  // Optionally expand flex columns if options.expand === true and there is extra space
  if (options.expand && currentTotal < termW) {
    const flexIndices = activeCols.map((c, i) => (c.flex ? i : -1)).filter(i => i >= 0);
    let extra = termW - currentTotal;
    let cursor = 0;
    while (extra > 0 && flexIndices.length > 0) {
      const idx = flexIndices[cursor % flexIndices.length];
      if (widths[idx] < activeCols[idx].maxWidth) {
        widths[idx]++;
        extra--;
      } else {
        flexIndices.splice(cursor % flexIndices.length, 1);
        continue;
      }
      cursor++;
    }
  }

  const drawRule = (left, mid, right) => {
    const segments = widths.map(w => b.horizontal.repeat(w + 2));
    return borderFn(left + segments.join(mid) + right);
  };

  const drawRow = (cells, isHeader = false) => {
    // Support multiline or wrapped cells
    const splitCells = cells.map((cell, i) => {
      const w = widths[i];
      const col = activeCols[i];
      if (!isHeader && col.wrap) {
        return wrap(String(cell), w).map(line => pad(truncate(line, w, { ascii }), w, col.align));
      }
      const line = truncate(String(cell).replace(/\n/g, ' '), w, { ascii });
      const aligned = pad(line, w, isHeader ? (col.headerAlign || col.align) : col.align);
      return [isHeader ? headerFn(aligned) : aligned];
    });

    const maxLines = Math.max(1, ...splitCells.map(c => c.length));
    const vSep = borderFn(b.vertical);
    const outLines = [];

    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      const rowParts = splitCells.map((cellLines, colIdx) => {
        const content = cellLines[lineIdx] !== undefined ? cellLines[lineIdx] : ' '.repeat(widths[colIdx]);
        return ` ${content} `;
      });
      outLines.push(vSep + rowParts.join(vSep) + vSep);
    }
    return outLines;
  };

  const out = [];
  out.push(drawRule(b.topLeft, b.topMid, b.topRight));
  out.push(...drawRow(activeCols.map(c => c.label), true));
  out.push(drawRule(b.leftMid, b.midMid, b.rightMid));

  if (!safeRows.length) {
    const innerW = widths.reduce((a, w) => a + w, 0) + 3 * (activeCols.length - 1);
    const emptyMsg = truncate(options.emptyText || 'No entries', innerW, { ascii });
    const paddedEmpty = pad(theme ? theme.muted(emptyMsg) : emptyMsg, innerW, 'center');
    out.push(`${borderFn(b.vertical)} ${paddedEmpty} ${borderFn(b.vertical)}`);
  } else {
    for (let rIdx = 0; rIdx < safeRows.length; rIdx++) {
      const rowCells = activeCols.map((_, cIdx) => layout.colCells[cIdx][rIdx]);
      out.push(...drawRow(rowCells, false));
    }
  }

  out.push(drawRule(b.bottomLeft, b.bottomMid, b.bottomRight));
  return out;
}

module.exports = {
  renderTable,
  renderStackedBlocks,
  formatCellValue,
};
