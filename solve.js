// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader's {columns, rows, errors} for every {text, header}, but reads
// the text with bulk scans instead of one character at a time.
//
// First principles: the reference spends its time stepping char by char and
// growing every field one character at a time. Most of a file is plain text
// — unquoted fields, commas, line breaks — so this parser finds each field's
// end with indexOf (V8's memchr-fast scan) and cuts it out with one slice.
// Only the rare broken bits (quotes, stray CRs) take the careful path, and
// every branch below reproduces the reference's exact decisions, including
// its error records and their order.
//
// One subtlety shapes the whole design: String.indexOf scans to the end of
// the text when its character is absent, so every search here is bounded to
// the field or line it belongs to — a search is never allowed to run past
// the delimiter it is looking for. (An unbounded search for a rare CR or
// quote is what makes a naive indexOf parser slow.)
//
// Policy (csv-reader 1.0.0, as the reference states it):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; each CRLF or lone CR inside it reads as LF;
//   what follows its closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends); a quote that
//   never closes is a literal character and the text after it is read again
//   as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded with "" (short_row, with fields: its
//   field count) or cut (long_row, with extra: the cut fields) to the first
//   record's width.
// - Each error is {code, line, row}, in the order met: line the 1-based line
//   its record starts on, row its record's index in rows, null for the header.

const CR_RE = /\r\n?/g;

// How a field ended: 0 at a comma, 1 at a line break, 2 at the end of text.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Outcome of the last readUnquoted call.
  let uEnded = 2;
  let uAdded = 0;

  // Reads unquoted characters from `start`, starting from `init`, up to the
  // next comma or line break. A CR not followed by LF is dropped (stray_cr).
  // Returns the field; uEnded says how it ended, uAdded how many characters
  // it kept (the junk check counts kept characters, dropped CRs excluded).
  // Advances pos and line past the terminator.
  function readUnquoted(start, init) {
    const c = text.indexOf(',', start);
    const n = text.indexOf('\n', start);
    let end;
    let isComma;
    if (c === -1) {
      end = n === -1 ? len : n;
      isComma = false;
    } else if (n === -1) {
      end = c;
      isComma = true;
    } else if (c < n) {
      end = c;
      isComma = true;
    } else {
      end = n;
      isComma = false;
    }
    // The field's span holds no LF (end is the first comma or LF), so any
    // CR in it is either the CRLF at its very end or a stray CR.
    const f = text.slice(start, end);
    const r = f.indexOf('\r');
    let value = init;
    let added = 0;
    if (r === -1) {
      value += f;
      added = f.length;
    } else if (r === f.length - 1 && !isComma && n !== -1) {
      // CRLF: the CR is the line break, the LF belongs to it.
      value += f.slice(0, r);
      added = r;
    } else {
      // Stray CRs, one error each, dropped as the field goes on. A CR at
      // the very end of the span, just before an LF terminator, is the
      // CRLF of the line break, not a stray CR (a stray-CR field that is
      // also the last field of a CRLF record holds both).
      const crlfTail = !isComma && n !== -1 && f.charCodeAt(f.length - 1) === 13;
      let k = 0;
      let total = 0;
      while ((k = f.indexOf('\r', k)) !== -1) {
        total += 1;
        if (!(crlfTail && k === f.length - 1)) {
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        }
        k += 1;
      }
      value += f.replaceAll('\r', '');
      added = f.length - total;
    }
    if (end === len) {
      pos = len;
      uEnded = 2;
    } else if (isComma) {
      pos = end + 1;
      uEnded = 0;
    } else {
      pos = end + 1;
      line += 1;
      uEnded = 1;
    }
    uAdded = added;
    return value;
  }

  // Finishes a record: header, padding/cutting to the first record's width.
  function finish(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < len) {
    // Lines with no characters are no records.
    let ch = text.charCodeAt(pos);
    if (ch === 10) {
      pos += 1;
      line += 1;
      continue;
    }
    if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      continue;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this line holds no quote and no CR except a trailing CRLF,
    // so the record is the whole line and its fields are one split. All
    // searches stay inside the line's own slice. A quote or a stray CR
    // anywhere on the line takes the slow path.
    const lineEnd = text.indexOf('\n', pos);
    const end = lineEnd === -1 ? len : lineEnd;
    const lineText = text.slice(pos, end);
    if (lineText.indexOf('"') === -1) {
      let rec = lineText;
      if (lineEnd !== -1 && rec.charCodeAt(rec.length - 1) === 13) rec = rec.slice(0, -1);
      if (rec.indexOf('\r') === -1) {
        if (rec.length === 0) {
          // An empty line (only reachable as "\r\n", the "\n" case is
          // skipped above): no record.
          pos = lineEnd === -1 ? len : lineEnd + 1;
          line += 1;
          continue;
        }
        const fields = rec.split(',');
        pos = lineEnd === -1 ? len : lineEnd + 1;
        line += 1;
        finish(fields);
        continue;
      }
    }

    // Slow path: field by field, for lines with quotes or stray CRs.
    const fields = [];
    let lastQuoted = false;
    let ended;
    for (;;) {
      let value;
      if (pos >= len) {
        value = '';
        ended = 2;
        lastQuoted = false;
      } else if (text.charCodeAt(pos) === 34) {
        // A quoted field: find its closing quote, skipping doubled quotes.
        const open = pos;
        const openLine = line;
        let qq = text.indexOf('"', open + 1);
        let hasDoubled = false;
        while (qq !== -1 && text.charCodeAt(qq + 1) === 34) {
          hasDoubled = true;
          qq = text.indexOf('"', qq + 2);
        }
        if (qq === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          value = readUnquoted(open + 1, '"');
          ended = uEnded;
        } else {
          const v0 = text.slice(open + 1, qq);
          // Count the line breaks inside the quotes on the slice itself:
          // each LF counts once, each CR counts once, a CRLF pair counts
          // once (its LF belongs to the CR). Also note any CR at all.
          let nl = 0;
          let hasCR = false;
          let i = 0;
          let a;
          while ((a = v0.indexOf('\n', i)) !== -1) {
            nl += 1;
            i = a + 1;
          }
          i = 0;
          while ((a = v0.indexOf('\r', i)) !== -1) {
            hasCR = true;
            if (v0.charCodeAt(a + 1) !== 10) nl += 1;
            i = a + 1;
          }
          line += nl;
          let v = v0;
          if (hasCR) v = v.replace(CR_RE, '\n');
          if (hasDoubled) v = v.replaceAll('""', '"');
          pos = qq + 1;
          if (pos >= len) {
            value = v;
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              value = v;
              ended = 0;
              pos += 1;
            } else if (c === 10) {
              value = v;
              ended = 1;
              pos += 1;
              line += 1;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              value = v;
              ended = 1;
              pos += 2;
              line += 1;
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              value = readUnquoted(pos, v);
              ended = uEnded;
              if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
        lastQuoted = true;
      } else {
        value = readUnquoted(pos, '');
        ended = uEnded;
        lastQuoted = false;
      }
      fields.push(value);
      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finish(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
