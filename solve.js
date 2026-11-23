// A faster drop-in for makefun-site 1.0.0: run(input) returns the same output tree as its build(input),
// byte for byte, following the rules in vendor/makefun-site/README.md; its code is the reference.
//
// Speed comes from doing the same work with less of it:
//  - templates are parsed once and compiled into JavaScript functions (loops bind locals, paths become
//    property reads) instead of walking a node tree with a scope-chain lookup per value;
//  - Markdown is rendered in one pass, and inline text is escaped in whole runs between the characters
//    that can start markup, instead of character by character;
//  - slugs, word counts, long dates and pre-formatted links are computed once and reused;
//  - front matter is read without splitting the whole body into lines.

const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

const NEEDS_ESCAPE = /[&<>"']/;

/** `text` with & < > " ' escaped (and nothing else). */
function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    let rep;
    switch (text.charCodeAt(i)) {
      case 38:
        rep = '&amp;';
        break;
      case 60:
        rep = '&lt;';
        break;
      case 62:
        rep = '&gt;';
        break;
      case 34:
        rep = '&quot;';
        break;
      case 39:
        rep = '&#39;';
        break;
      default:
        continue;
    }
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return out + text.slice(last);
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const MARKS = /\p{M}/gu;

/** The slug of `text`: NFKD, marks dropped, A-Z lowered, other runs one "-", cut to 64, "untitled" when empty. */
function slugify(text) {
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep;
    if (c >= 97 && c <= 122) keep = c;
    else if (c >= 48 && c <= 57) keep = c;
    else if (c >= 65 && c <= 90) keep = c + 32;
    else {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const m = date.charCodeAt(5) === 48 ? date.charCodeAt(6) - 48 : (date.charCodeAt(5) - 48) * 10 + date.charCodeAt(6) - 48;
  const d = date.charCodeAt(8) === 48 ? date.charCodeAt(9) - 48 : (date.charCodeAt(8) - 48) * 10 + date.charCodeAt(9) - 48;
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether the code unit `c` is whitespace, in JavaScript's \s sense. */
function isSpaceCode(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isSpaceCode(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;
const TRAILING_SPACE = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

const BAD_DATE = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      if (m === null) return BAD_DATE;
      const y = +m[1];
      const mo = +m[2];
      const d = +m[3];
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return BAD_DATE;
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) if (tags[i] === '' || !TAG.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body, or the first reason it is refused. The body is the text after the closing
 * line, taken as a slice so it is never split and joined again.
 */
function parseFrontMatter(text) {
  if (text.startsWith('---')) {
    if (text.length === 3) return { error: 'the front matter is not closed' };
    if (text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  } else return { error: 'no front matter' };
  // The front matter ends at the next line that is exactly "---"; its body is a slice, never split and joined.
  let headerEnd = -1;
  let bodyStart = -1;
  let from = 3;
  for (;;) {
    const at = text.indexOf('\n---', from);
    if (at === -1) break;
    const end = at + 4;
    if (end === text.length) {
      headerEnd = at;
      bodyStart = end;
      break;
    }
    if (text.charCodeAt(end) === 10) {
      headerEnd = at;
      bodyStart = end + 1;
      break;
    }
    from = end - 3;
  }
  if (headerEnd === -1) return { error: 'the front matter is not closed' };
  const header = headerEnd > 4 ? text.slice(4, headerEnd) : '';
  const body = bodyStart >= text.length ? '' : text.slice(bodyStart);
  const data = {};
  if (header !== '') {
    const lines = header.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.charCodeAt(0) === 35) continue;
      if (BLANK_LINE.test(line)) continue;
      const m = LINE.exec(line);
      if (m === null) return { error: `line ${i + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(TRAILING_SPACE, '');
      if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ------------------------------------------------------------------ markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** `line` blank (spaces and tabs only)? */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimBoth(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96 && FENCE_OPEN.test(line)) return true;
  if (c0 === 35 && headingOf(line) !== null) return true;
  return (c0 === 45 || c0 === 42) && HR.test(line);
}

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** The first index from `from` where `s` holds `what` (']' or '**') outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const single = what.length === 1;
  const code = what.charCodeAt(0);
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (single) {
      if (c === code) return j;
    } else if (c === code && s.charCodeAt(j + 1) === code) return j;
  }
  return -1;
}

/** The first single * from `from` (whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_SPACE = /\s/;
const INLINE_SPECIAL = /[\\`*[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  INLINE_SPECIAL.lastIndex = 0;
  const first = INLINE_SPECIAL.exec(s);
  if (first === null) return escapeHtml(s);
  let out = '';
  let last = 0;
  let i = first.index;
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        if (last !== i) out += escapeHtml(s.slice(last, i));
        out += escapeHtml(s[i + 1]);
        i += 2;
        last = i;
      } else i++;
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (last !== i) out += escapeHtml(s.slice(last, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        last = i;
      } else i++;
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (last !== i) out += escapeHtml(s.slice(last, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          last = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (last !== i) out += escapeHtml(s.slice(last, i));
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
          last = i;
        } else i++;
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !HAS_SPACE.test(target)) {
        if (last !== i) out += escapeHtml(s.slice(last, i));
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        last = i;
      } else i++;
    } else i++;
    if (i >= s.length) break;
    INLINE_SPECIAL.lastIndex = i;
    const next = INLINE_SPECIAL.exec(s);
    if (next === null) break;
    i = next.index;
  }
  if (last === 0) return escapeHtml(s);
  return last === s.length ? out : out + escapeHtml(s.slice(last));
}

/** Whether the range `[a, b)` of `src` is blank (spaces and tabs only). */
function isBlankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` rendered in one pass: its HTML, its table of contents and its excerpt. */
function renderMarkdown(src, env) {
  // Lines are ranges of `src`, so a blank line costs no string and no array entry.
  const total = src.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let line = '';
  let i = 0;
  const readLine = () => {
    let end = src.indexOf('\n', i);
    if (end === -1) end = total;
    line = src.slice(i, end);
    i = end + 1;
  };
  while (i < total) {
    let end = src.indexOf('\n', i);
    if (end === -1) end = total;
    if (isBlankRange(src, i, end)) {
      i = end + 1;
      continue;
    }
    line = src.slice(i, end);
    i = end + 1;
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        let code = '';
        while (i < total) {
          readLine();
          if (FENCE_CLOSE.test(line)) break;
          code += `${escapeHtml(line)}\n`;
        }
        const lang = fence[1];
        html += lang === '' ? `<pre><code>${code}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>\n`;
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const inner = inline(heading.text, env);
        const depth = heading.depth;
        html += `<h${depth} id="${id}">${inner}</h${depth}>\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: inner });
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      html += '<hr>\n';
      continue;
    }
    if (c0 === 62) {
      const body = [];
      for (;;) {
        const t = trimBoth(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1));
        if (t !== '') body.push(t);
        if (i >= total || src.charCodeAt(i) !== 62) break;
        readLine();
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    let bullet = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    let ordered = null;
    if (bullet === null && c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      for (;;) {
        const m = marker.exec(line);
        if (m !== null) items.push([trimBoth(isOrdered ? m[2] : m[1])]);
        else if (CONTINUED.test(line)) items[items.length - 1].push(trimBoth(line));
        else break;
        if (i >= total) break;
        let next = src.indexOf('\n', i);
        if (next === -1) next = total;
        const peek = src.slice(i, next);
        // A line that ends the list is left for the outer loop, never consumed here.
        if (marker.exec(peek) === null && !CONTINUED.test(peek)) break;
        line = peek;
        i = next + 1;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : isOrdered ? '<ol>' : '<ul>';
      let body = '';
      for (let k = 0; k < items.length; k++) body += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      html += `${open}\n${body}</${isOrdered ? 'ol' : 'ul'}>\n`;
      continue;
    }
    const body = [trimBoth(line)];
    while (i < total) {
      let next = src.indexOf('\n', i);
      if (next === -1) next = total;
      const text = src.slice(i, next);
      if (endsParagraph(text)) break;
      body.push(trimBoth(text));
      i = next + 1;
    }
    const inner = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}
// ------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const ONLY_SPACE = /^[ \t]*$/;

function templateError(name, why) {
  return new Error(`template "${name}": ${why}`);
}

function pathOf(name, text) {
  if (!PATH.test(text)) throw templateError(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw templateError(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = ONLY_SPACE.test(src.slice(lineStart, open)) && ONLY_SPACE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** `src` parsed into its tree of nodes. */
function parseTemplate(name, src) {
  const root = { kind: 0, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push({ kind: 3, text: tok.text });
    else if (tok.t === 1) body.push({ kind: 1, path: tok.path });
    else if (tok.t === 2) body.push({ kind: 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 5, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 5 || top.else !== null) throw templateError(name, 'an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 4 : 5)) throw templateError(name, `an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 0 || parent.kind === 4 ? parent.body : (parent.else ?? parent.then);
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 6, name: m[1] });
      else throw templateError(name, `{% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw templateError(name, `a ${stack[stack.length - 1].kind === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

// ------------------------------------------------------------------ template compilation

/**
 * A template's own reads (the names it takes from its scope) and the includes it makes with the names bound at each
 * site. Includes may form a cycle, so the free names are closed over the include graph by a fixpoint, not recursion.
 */
function scanTemplate(nodes) {
  const direct = new Set();
  const includes = [];
  const walk = (list, bound) => {
    for (const nd of list) {
      if (nd.kind === 1 || nd.kind === 2) {
        if (!bound.has(nd.path[0])) direct.add(nd.path[0]);
      } else if (nd.kind === 5) {
        if (!bound.has(nd.path[0])) direct.add(nd.path[0]);
        walk(nd.then, bound);
        if (nd.else !== null) walk(nd.else, bound);
      } else if (nd.kind === 4) {
        if (!bound.has(nd.path[0])) direct.add(nd.path[0]);
        const inner = new Set(bound);
        inner.add(nd.name);
        inner.add('loop');
        walk(nd.body, inner);
      } else if (nd.kind === 6) includes.push({ target: nd.name, bound: new Set(bound) });
    }
  };
  walk(nodes, new Set());
  return { direct, includes };
}

/** Each template's free names: what it reads itself, plus what its includes need that it does not bind. */
function freeNamesOf(templates, order) {
  const scanned = new Map();
  for (const name of order) scanned.set(name, scanTemplate(templates.get(name)));
  const free = new Map();
  for (const name of order) free.set(name, new Set(scanned.get(name).direct));
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of order) {
      const target = free.get(name);
      for (const site of scanned.get(name).includes) {
        const inner = free.get(site.target);
        if (inner === undefined) continue;
        for (const n of inner) {
          if (!site.bound.has(n) && !target.has(n)) {
            target.add(n);
            changed = true;
          }
        }
      }
    }
  }
  return free;
}

/** The compiled renderer of one template set: a function per template, `(V, S, d) => string`. */
function compileTemplates(templates, order) {
  const index = new Map();
  order.forEach((name, k) => index.set(name, k));

  const free = freeNamesOf(templates, order);

  // Names that an includer may bind, so a lookup cannot be read straight off the root vars.
  const outer = new Map();
  for (const name of order) outer.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of order) {
      const nodes = templates.get(name);
      const walk = (list, bound) => {
        for (const nd of list) {
          if (nd.kind === 6) {
            const target = outer.get(nd.name);
            if (target === undefined) continue;
            for (const b of bound) if (!target.has(b)) {
              target.add(b);
              changed = true;
            }
            for (const b of outer.get(name)) if (!target.has(b)) {
              target.add(b);
              changed = true;
            }
          } else if (nd.kind === 5) {
            walk(nd.then, bound);
            if (nd.else !== null) walk(nd.else, bound);
          } else if (nd.kind === 4) {
            const inner = new Set(bound);
            inner.add(nd.name);
            inner.add('loop');
            walk(nd.body, inner);
          }
        }
      };
      walk(nodes, new Set());
    }
  }

  const sources = [];
  for (const name of order) sources.push(compileOne(name, templates.get(name), index, free, outer));

  const factory = new Function(
    '$H',
    '$sv',
    '$rv',
    '$g',
    '$lk',
    '$p2',
    '$tr',
    `return [${sources.join(',')}];`,
  );
  const holder = { t: null, k: new Map(), e: new Map() };
  const list = factory(holder, sv, rv, g, lk, p2, tr);
  holder.t = list;
  return list;
}

/** The functions a compiled template calls. */
const sv = (v) => (typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
const rv = (v) => (typeof v === 'string' ? v : textOf(v));
const g = (V, k) => (Object.hasOwn(V, k) ? V[k] : undefined);
const lk = (S, k) => {
  let s = S;
  while (s !== null && !Object.hasOwn(s.vars, k)) s = s.parent;
  return s === null ? undefined : s.vars[k];
};
const p2 = (o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined);
const tr = (v) => {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
};


/** Whether `list` reads `name` outside a loop that binds it (an included template's reads count too). */
function readsName(list, name, bound, free) {
  for (const nd of list) {
    if (nd.kind === 1 || nd.kind === 2) {
      if (nd.path[0] === name && !bound.has(name)) return true;
    } else if (nd.kind === 5) {
      if (nd.path[0] === name && !bound.has(name)) return true;
      if (readsName(nd.then, name, bound, free)) return true;
      if (nd.else !== null && readsName(nd.else, name, bound, free)) return true;
    } else if (nd.kind === 4) {
      if (nd.path[0] === name && !bound.has(name)) return true;
      const inner = new Set(bound);
      inner.add(nd.name);
      inner.add('loop');
      if (readsName(nd.body, name, inner, free)) return true;
    } else if (nd.kind === 6) {
      const need = free.get(nd.name);
      if (need !== undefined && need.has(name) && !bound.has(name)) return true;
    }
  }
  return false;
}

/** The names whose values stay the same for every render of one build. */
const BUILD_CONSTANT = new Set(['site', 'tags', 'recent']);

/** One template's renderer source: loops bind locals, values are read straight off objects where they can be. */
function compileOne(name, nodes, index, free, outer) {
  let uid = 0;
  const body = [];

  const expr = (path, bound) => {
    let e;
    const head = path[0];
    const local = bound.get(head);
    if (local !== undefined) e = local;
    else if (!outer.get(name).has(head)) e = `$g(V,${JSON.stringify(head)})`;
    else e = `$lk(S,${JSON.stringify(head)})`;
    for (let k = 1; k < path.length; k++) e = `$p2(${e},${JSON.stringify(path[k])})`;
    return e;
  };

  const emit = (list, bound, indent, elem) => {
    for (const nd of list) {
      if (nd.kind === 3) body.push(`${indent}$o+=${JSON.stringify(nd.text)};`);
      else if (nd.kind === 1) body.push(`${indent}$o+=$sv(${expr(nd.path, bound)});`);
      else if (nd.kind === 2) body.push(`${indent}$o+=$rv(${expr(nd.path, bound)});`);
      else if (nd.kind === 5) {
        body.push(`${indent}if($tr(${expr(nd.path, bound)})!==${nd.not}){`);
        emit(nd.then, bound, indent, elem);
        if (nd.else !== null) {
          body.push(`${indent}}else{`);
          emit(nd.else, bound, indent, elem);
        }
        body.push(`${indent}}`);
      } else if (nd.kind === 4) {
        const id = uid++;
        const xs = `$xs${id}`;
        const len = `$n${id}`;
        const k = `$k${id}`;
        body.push(`${indent}const ${xs}=${expr(nd.path, bound)};`);
        body.push(`${indent}if(Array.isArray(${xs})){`);
        body.push(`${indent}const ${len}=${xs}.length;`);
        body.push(`${indent}for(let ${k}=0;${k}<${len};${k}++){`);
        const inner = new Map(bound);
        const needsLoop = readsName(nd.body, 'loop', new Set(), free);
        if (needsLoop) {
          inner.set('loop', `$l${id}`);
          body.push(`${indent}const $l${id}={index:${k}+1,first:${k}===0,last:${k}===${len}-1,length:${len}};`);
        }
        if (nd.name !== 'loop') inner.set(nd.name, `$e${id}`);
        if (nd.name !== 'loop') body.push(`${indent}const $e${id}=${xs}[${k}];`);
        emit(nd.body, inner, indent, nd.name === 'loop' ? null : { name: nd.name, v: `$e${id}` });
        body.push(`${indent}}}`);
      } else if (nd.kind === 6) {
        const target = index.get(nd.name);
        if (target === undefined) continue;
        const need = free.get(nd.name);
        // Build the caller's chain from the innermost binding outwards, passing only what the include reads.
        const chain = [];
        for (const [bindName, localVar] of bound) if (need.has(bindName)) chain.push([bindName, localVar]);
        const key = `((${target}<<3)+d)`;
        // An include whose values never change (or change only with one loop's element) is rendered once and kept.
        let constant = chain.length === 0;
        let perElement = null;
        if (constant) {
          for (const n of need) if (!BUILD_CONSTANT.has(n)) constant = false;
        } else if (chain.length === 1 && elem !== null && chain[0][0] === elem.name && !need.has('loop')) {
          perElement = elem.v;
          for (const n of need) if (!BUILD_CONSTANT.has(n) && n !== elem.name) perElement = null;
        }
        if (constant) {
          body.push(`${indent}if(d<8){let $v=$H.k.get(${key});if($v===undefined){$v=$H.t[${target}](V,S,d+1);$H.k.set(${key},$v);}$o+=$v;}`);
        } else if (perElement !== null) {
          body.push(`${indent}if(d<8){let $m=$H.e.get(${key});if($m===undefined){$m=new Map();$H.e.set(${key},$m);}let $v=$m.get(${perElement});if($v===undefined){$v=$H.t[${target}](V,{vars:{${JSON.stringify(elem.name)}:${perElement}},parent:S},d+1);$m.set(${perElement},$v);}$o+=$v;}`);
        } else if (chain.length === 0) body.push(`${indent}if(d<8)$o+=$H.t[${target}](V,S,d+1);`);
        else {
          let scope = 'S';
          for (const [bindName, localVar] of chain) scope = `{vars:{${JSON.stringify(bindName)}:${localVar}},parent:${scope}}`;
          body.push(`${indent}if(d<8)$o+=$H.t[${target}](V,${scope},d+1);`);
        }
      }
    }
  };

  emit(nodes, new Map(), '', null);
  return `function(V,S,d){let $o="";${body.join('')}return $o;}`;
}

// ------------------------------------------------------------------ the build

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

function resolvePath(dir, rel) {
  // A relative path with no step, no empty segment and no trailing slash resolves to itself under `dir`.
  if (rel.indexOf('.') === -1 && rel.indexOf('//') === -1 && !rel.endsWith('/')) return dir === '' ? rel : `${dir}/${rel}`;
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const PROTOCOL = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += k === 0 ? textOf(v[k]) : `, ${textOf(v[k])}`;
    return out;
  }
  return '';
}

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // Templates, parsed in code-unit order of their names.
  const templates = new Map();
  const order = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of order) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      report.push(err.message);
    }
  }
  const compiled = compileTemplates(templates, order.filter((name) => templates.has(name)));
  const indexOfTemplate = new Map();
  order.filter((name) => templates.has(name)).forEach((name, k) => indexOfTemplate.set(name, k));

  // Sources and statics, in code-unit order of their paths.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    s.text = undefined;
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = dir === '' ? new Set(RESERVED) : new Set();
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (PROTOCOL.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const slugOf = new Map();
  const slugOfName = (nm) => {
    let slug = slugOf.get(nm);
    if (slug === undefined) {
      slug = slugify(nm);
      slugOf.set(nm, slug);
    }
    return slug;
  };
  const ownTagNames = (s) => {
    const tags = s.data.tags ?? [];
    if (tags.length === 0) return tags;
    const seen = new Set();
    const out = [];
    for (const nm of tags) {
      const slug = slugOfName(nm);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(nm);
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const nm of ownTagNames(p)) {
      const slug = slugOfName(nm);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: nm, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((nm) => {
      const slug = slugOfName(nm);
      return bySlug.get(slug) ?? { name: nm, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, built once per source and reused by every list that shows it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));

  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

  // Layouts.
  const out = {};
  const siteObj = { title: site.title, base_url: base };
  const tagsList = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  const rootScope = { vars: { site: siteObj, tags: tagsList, recent }, parent: null };
  const render = (name, extra) => {
    const k = indexOfTemplate.get(name);
    if (k === undefined) return null;
    const node = compiled[k];
    if (extra === undefined) {
      const scope = { vars: rootScope.vars, parent: null };
      return node(rootScope.vars, scope, 0);
    }
    const vars = { site: siteObj, tags: tagsList, recent };
    for (const key in extra) vars[key] = extra[key];
    return node(vars, { vars, parent: null }, 0);
  };

  for (const s of kept) {
    const card = cards.get(s);
    out[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        title: card.title,
        url: card.url,
        date: card.date,
        date_long: card.date_long,
        summary: card.summary,
        excerpt: card.excerpt,
        reading_minutes: card.reading_minutes,
        tags: card.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }

  // Every card is built and every page rendered: the per-source buffers are no longer needed.
  for (const s of kept) {
    s.body = undefined;
    s.html = undefined;
    s.toc = undefined;
    s.excerpt = undefined;
    s.data = undefined;
  }

  const per = site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) out[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) out[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', undefined);
  if (tagsHtml !== null) out['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(out, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else out[f.path] = f.content;
  }

  // The report.
  for (const line of broken) report.push(line);
  report.sort(byCodeUnits);
  let pages = 0;
  for (const s of kept) if (!s.post) pages++;
  report.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  out['build-report.txt'] = `${report.join('\n')}\n`;
  return out;
}
