// search.js
//
// Search parser + IndexedDB-backed filter with support for logical AND and NOT.
//
// Exports:
//  - parseSearch(query) -> clauses (array of clause arrays of term objects { field, value, negated })
//  - matchPatch(patch, clauses, fieldMap)
//  - searchPatches(dbPromise, storeName, query, fieldMap)
//
// Notes:
//  - field prefixes: n:, m:, d:, a:, c:, t: (name, manufacturer, device, author, comment/description, tags)
//  - quoted tokens allowed with single or double quotes; backslash can escape characters inside quotes
//  - && combines terms into an AND clause; clauses are OR'ed
//  - NOT operator: prefix a term with '!' (e.g. '!pad' or '! pad'). To use literal '!' escape it: \!pad

function tokenize(query) {
  if (!query)
    return [];

  const tokens = [];
  const len = query.length;
  let i = 0;

  while (i < len) {
    // skip whitespace
    while (i < len && /\s/.test(query[i])) i++;

    if (i >= len)
      break;

    // handle && as separate token
    if (query[i] === '&' && query[i+1] === '&') {
      tokens.push('&&');
      i += 2;
      continue;
    }

    // handle standalone '!' as token (unescaped)
    if (query[i] === '!') {
      const prev = i > 0 ? query[i - 1] : null;

      if (prev !== '\\') {
        tokens.push('!');
        i++;
        continue;
      }
      // else fall through (escaped '!' will be part of token)
    }

    const ch = query[i];

    // If token starts with a quote, read entire quoted token (no splitting)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = '';

      while (i < len) {
        const c = query[i];

        if (c === '\\' && i + 1 < len) {
          // append escaped char
          buf += query[i + 1];
          i += 2;
          continue;
        }

        if (c === quote) {
          i++;
          break;
        }

        buf += c;
        i++;
      }
      tokens.push(buf);
      continue;
    }

    // Unquoted token: read until whitespace, but allow quoted substrings inside token
    let buf = '';
    while (i < len && !/\s/.test(query[i])) {
      // stop before && sequence so it becomes separate token
      if (query[i] === '&' && query[i + 1] === '&')
        break;

      // If we encounter a quote inside an unquoted token, consume the quoted substring
      if (query[i] === '"' || query[i] === "'") {
        const quote = query[i];
        i++; // skip opening quote
        let inner = '';

        while (i < len) {
          const c = query[i];

          if (c === '\\' && i + 1 < len) {
            inner += query[i + 1];
            i += 2;
            continue;
          }
          if (c === quote) {
            i++; // skip closing
            break;
          }

          inner += c;
          i++;
        }
        buf += inner;
        continue;
      }

      buf += query[i++];
    }

    if (buf.length)
      tokens.push(buf);
  }

  return tokens;
}

const prefixMap = {
  n: 'name',
  m: 'manufacturer',
  d: 'device',
  a: 'author',
  c: 'description',
  t: 'tags'
};

function stripLeadingUnescapedExclamation(s) {
  if (!s || s.length === 0) {
    return { negated: false, text: s };
  }

  // literal escaped exclamation: starts with '\!'
  if (s[0] === '\\' && s[1] === '!') {
    return { negated: false, text: s.slice(1) }; // drop backslash, keep '!'
  }

  if (s[0] === '!') {
    return { negated: true, text: s.slice(1) };
  }

  return { negated: false, text: s };
}

function parseTokenToTerm(token) {
  if (!token) return null;

  // handle escape of leading \! -> literal '!' preserved (we remove backslash)
  const leading = stripLeadingUnescapedExclamation(token);
  const negated = leading.negated;
  const t = leading.text;
  const colonIndex = t.indexOf(':');

  if (colonIndex > 0) {
    const p = t.slice(0, colonIndex).toLowerCase();
    const rest = t.slice(colonIndex + 1);

    if (p.length === 1 && prefixMap[p]) {
      return { field: prefixMap[p], value: rest, negated };
    }
  }

  return { field: 'any', value: t, negated };
}

export function parseSearch(query) {
  const tokens = tokenize(query);
  const clauses = [];
  let i = 0;
  const n = tokens.length;

  while (i < n) {
    // skip stray &&
    if (tokens[i] === '&&') {
      i++;
      continue;
    }

    // handle possible '!' token before an actual term: attach negation to next term
    let pendingNegation = false;

    if (tokens[i] === '!') {
      pendingNegation = true;
      i++;

      if (i >= n)
        break;
    }

    const clause = [];

    // tokens[i] should be a term (not &&, not lone '!')
    if (tokens[i] === '&&') {
      i++;
      continue;
    }

    const rawToken = tokens[i];
    // if rawToken starts with a backslash and exclamation, parseTokenToTerm will remove backslash
    let term = parseTokenToTerm(rawToken);

    if (!term) {
      i++; continue;
    }

    if (pendingNegation)
      term = { ...term, negated: true };

    clause.push(term);
    i++;

    // now consume chained && term pairs into this clause (AND)
    while (i < n && tokens[i] === '&&') {
      i++; // skip &&

      if (i >= n)
       break;

      if (tokens[i] === '&&')
        continue;

      // support '!' preceding that term as well
      let neg = false;

      if (tokens[i] === '!') {
        neg = true;
        i++;

        if (i >= n)
          break;
      }

      const raw = tokens[i];
      const t = parseTokenToTerm(raw);

      if (t) {
        const merged = { ...t, negated: (t.negated || neg) };
        clause.push(merged);
      }

      i++;
    }

    if (clause.length)
      clauses.push(clause);
  }
  return clauses;
}

/* Matching logic:
  - clause: array of terms combined by AND
  - clauses: OR between clauses
  - term: { field, value, negated }
    - negated true: term must NOT match
    - field === 'any': test all mapped fields
*/
function valueAsString(v) {
  if (v === null || v === undefined)
    return '';

  if (typeof v === 'string')
    return v;

  if (v instanceof Date)
    return v.toISOString();

  return String(v);
}

export function matchTermOnPatch(term, patch, fieldMap) {
  if (!term || typeof term.value !== 'string')
    return false;

  const needle = term.value.toLowerCase();

  const tryField = (key) => {
    if (!key)
      return false;

    const val = patch[key];

    if (val == null)
      return false;

    if (Array.isArray(val)) {
      for (const el of val) {
        if (valueAsString(el).toLowerCase().includes(needle))
          return true;
      }

      return false;
    }

    return valueAsString(val).toLowerCase().includes(needle);
  };

  if (term.field === 'any') {
    for (const logical of Object.keys(fieldMap)) {
      const key = fieldMap[logical];

      if (!key)
        continue;

      if (tryField(key))
        return true;
    }

    return false;
  }

  const mapped = fieldMap[term.field];

  if (!mapped)
    return false;

  return tryField(mapped);
}

export function matchPatch(patch, clauses, fieldMap) {
  if (!clauses || clauses.length === 0)
    return true;

  // OR across clauses
  for (const clause of clauses) {
    let clauseOk = true;

    for (const term of clause) {
      const matches = matchTermOnPatch(term, patch, fieldMap);

      if (term.negated) {
        // for negated term, if it matches => clause fails
        if (matches) {
           clauseOk = false;
           break;
        }
      } else {
        // positive term must match
        if (!matches) {
          clauseOk = false;
          break;
        }
      }
    }

    if (clauseOk)
      return true;
  }
  return false;
}

export async function searchPatches(dbPromise, storeName, query, fieldMap) {
  const db = await dbPromise;

  if (!query || !query.trim()) {
    // return all
    if (typeof db.getAll === 'function') {
      return await db.getAll(storeName);
    }
  }

  const clauses = parseSearch(query);
  const tx = db.transaction(storeName, 'readonly');
  let objectStore;

  try {
    if (tx.store) objectStore = tx.store;
    else objectStore = tx.objectStore(storeName);
  } catch (e) {
    objectStore = tx.objectStore ? tx.objectStore(storeName) : tx.store;
  }

  const results = [];
  const cursorIter = objectStore.openCursor();

  if (cursorIter && typeof cursorIter[Symbol.asyncIterator] === 'function') {
    for await (const cursor of cursorIter) {
      const patch = cursor.value;

      if (matchPatch(patch, clauses, fieldMap))
        results.push(patch);
    }
  } else {
    let cursor = await objectStore.openCursor();

    while (cursor) {
      const patch = cursor.value;

      if (matchPatch(patch, clauses, fieldMap))
        results.push(patch);

      cursor = await cursor.continue();
    }
  }

  if (tx.done)
    await tx.done;

  return results;
}
