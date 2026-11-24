// main.ts is mend, the CLI SPEC.md specifies (MIT).
// Implements sections 1-10 of SPEC.md.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

interface FileDoc {
  lines: string[];
  br: '\r\n' | '\n';
  hasFinalBreak: boolean;
}

function parseFileDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', hasFinalBreak: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  const hasFinalBreak = text.endsWith(br);
  if (hasFinalBreak) lines.pop();
  return { lines, br, hasFinalBreak };
}

function stringifyFileDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.hasFinalBreak ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))
    )
  )
    return 'unified';
  return null;
}

// Section 5 - Line matching & Tier 2 indentation
function lineMatch(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) {
    return fileLine.replace(/[ \t]+$/, '') === patchLine.replace(/[ \t]+$/, '');
  }
  return (
    fileLine.replace(/^[ \t]+|[ \t]+$/, '') === patchLine.replace(/^[ \t]+|[ \t]+$/, '')
  );
}

function findOccurrencesAtTier(fileLines: string[], O: string[], tier: number): number[] {
  const occ: number[] = [];
  const maxI = fileLines.length - O.length;
  for (let i = 0; i <= maxI; i++) {
    let match = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineMatch(fileLines[i + k], O[k], tier)) {
        match = false;
        break;
      }
    }
    if (match) occ.push(i);
  }
  return occ;
}

function findOccurrences(
  fileLines: string[],
  O: string[],
  strict: boolean
): { tier: number; occurrences: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = findOccurrencesAtTier(fileLines, O, tier);
    if (occ.length > 0) return { tier, occurrences: occ };
  }
  return null;
}

function reindentTier2(line: string, F: string, P: string): string {
  if (line.replace(/[ \t]/g, '') === '') return line;
  if (line.startsWith(P)) {
    return F + line.slice(P.length);
  }
  return line;
}

// Section 9 - JSON Edits
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Section 7 - SEARCH/REPLACE blocks
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  let lastBlockEnd = -1;
  let prevPath: string | null = null;
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let foundPath: string | null = null;
      for (let p = i - 1; p > lastBlockEnd; p--) {
        const l = lines[p];
        if (!blank(l)) {
          const trimmed = l.trim();
          if (!trimmed.startsWith('```')) {
            foundPath = trimmed;
            break;
          }
        }
      }
      const path = foundPath ?? prevPath;
      if (path === null) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      let eqIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '=======') {
          eqIdx = j;
          break;
        }
        if (lines[j].trimEnd() === '<<<<<<< SEARCH') {
          throw new Exit2(`error: parse ${searchLineNum}`);
        }
      }
      if (eqIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      let replaceIdx = -1;
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          replaceIdx = j;
          break;
        }
        if (lines[j].trimEnd() === '<<<<<<< SEARCH' || lines[j].trimEnd() === '=======') {
          throw new Exit2(`error: parse ${searchLineNum}`);
        }
      }
      if (replaceIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNum}`);
      }

      const oldLines = lines.slice(i + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, replaceIdx);
      prevPath = path;
      lastBlockEnd = replaceIdx;
      i = replaceIdx + 1;

      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (oldLines.length === 0) {
          if (tree.get(path) !== null) throw new Fail('exists', path);
          const out = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
          tree.now.set(path, out);
        } else {
          const before = tree.get(path);
          if (before === null) throw new Fail('missing', path);
          const doc = parseFileDoc(before);
          const maxTier = strict ? 0 : 2;
          let matchedTier = -1;
          let matchedOccurrences: number[] = [];
          for (let t = 0; t <= maxTier; t++) {
            const occ = findOccurrencesAtTier(doc.lines, oldLines, t);
            if (occ.length > 0) {
              matchedTier = t;
              matchedOccurrences = occ;
              break;
            }
          }
          if (matchedTier === -1) throw new Fail('no-match', path);
          if (matchedOccurrences.length > 1) throw new Fail('ambiguous', path);
          const pos = matchedOccurrences[0];
          const F = (doc.lines[pos] ?? '').match(/^[ \t]*/)?.[0] ?? '';
          const P = oldLines[0].match(/^[ \t]*/)?.[0] ?? '';
          const rep = newLines.map((l) => (matchedTier === 2 ? reindentTier2(l, F, P) : l));
          doc.lines.splice(pos, oldLines.length, ...rep);
          tree.now.set(path, stringifyFileDoc(doc));
        }
      });
    } else {
      i++;
    }
  }
  return edits;
}

// Section 6 - Unified diffs
interface UnifiedHunk {
  A: number;
  C: number;
  body: Array<{ kind: 'context' | 'old' | 'new' | 'backslash'; text: string }>;
  O: string[];
  N: Array<{ isContext: boolean; contextOIndex?: number; text: string }>;
  hasNoEolAfterLast: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreation: boolean;
  isDeletion: boolean;
  hunks: UnifiedHunk[];
}

function cleanDiffPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnifiedSections(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: {
    oldPath: string | null;
    newPath: string | null;
    isCreation: boolean;
    isDeletion: boolean;
    hunks: UnifiedHunk[];
    inHeader: boolean;
  } | null = null;

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const lineNum = i + 1;

    if (l.startsWith('diff --git ')) {
      const rest = l.slice(11);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNum}`);
      const bIdx = rest.indexOf(' b/', 2);
      if (bIdx < 0) throw new Exit2(`error: parse ${lineNum}`);
      const x = rest.slice(2, bIdx);
      const y = rest.slice(bIdx + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${lineNum}`);

      if (cur !== null) sections.push(cur);
      cur = {
        oldPath: x,
        newPath: y,
        isCreation: false,
        isDeletion: false,
        hunks: [],
        inHeader: true,
      };
      i++;
      continue;
    }

    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && (!cur || !cur.inHeader)) {
      if (cur !== null) sections.push(cur);
      const oldP = cleanDiffPath(l.slice(4));
      const newP = cleanDiffPath(lines[i + 1].slice(4));
      cur = {
        oldPath: oldP,
        newPath: newP,
        isCreation: oldP === '/dev/null',
        isDeletion: newP === '/dev/null',
        hunks: [],
        inHeader: true,
      };
      i += 2;
      continue;
    }

    if (cur !== null && cur.inHeader) {
      if (l.startsWith('--- ')) {
        if (!lines[i + 1]?.startsWith('+++ ')) {
          const nextLineNum = lines[i + 1] !== undefined ? lineNum + 1 : lines.length + 1;
          throw new Exit2(`error: parse ${nextLineNum}`);
        }
        const oldP = cleanDiffPath(l.slice(4));
        const newP = cleanDiffPath(lines[i + 1].slice(4));
        cur.oldPath = oldP;
        cur.newPath = newP;
        if (oldP === '/dev/null') cur.isCreation = true;
        if (newP === '/dev/null') cur.isDeletion = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.oldPath = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.newPath = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreation = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDeletion = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        cur.inHeader = false;
      } else {
        i++;
        continue;
      }
    }

    if (l.startsWith('@@')) {
      if (cur === null) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
      const A = parseInt(m[1], 10);
      const C = parseInt(m[2], 10);

      let j = i + 1;
      const rawBody: string[] = [];
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[j + 1]?.startsWith('+++ ')) break;
        if (
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\') ||
          bl === ''
        ) {
          rawBody.push(bl);
          j++;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') {
        rawBody.pop();
      }

      const body: Array<{ kind: 'context' | 'old' | 'new' | 'backslash'; text: string }> = [];
      for (const r of rawBody) {
        if (r === '') body.push({ kind: 'context', text: '' });
        else if (r.startsWith(' ')) body.push({ kind: 'context', text: r.slice(1) });
        else if (r.startsWith('-')) body.push({ kind: 'old', text: r.slice(1) });
        else if (r.startsWith('+')) body.push({ kind: 'new', text: r.slice(1) });
        else if (r.startsWith('\\')) body.push({ kind: 'backslash', text: r });
      }

      const O: string[] = [];
      const N: Array<{ isContext: boolean; contextOIndex?: number; text: string }> = [];
      let lastContextOrPlusIdx = -1;

      for (let bIdx = 0; bIdx < body.length; bIdx++) {
        const item = body[bIdx];
        if (item.kind === 'context') {
          const oIdx = O.length;
          O.push(item.text);
          N.push({ isContext: true, contextOIndex: oIdx, text: item.text });
          lastContextOrPlusIdx = bIdx;
        } else if (item.kind === 'old') {
          O.push(item.text);
        } else if (item.kind === 'new') {
          N.push({ isContext: false, text: item.text });
          lastContextOrPlusIdx = bIdx;
        }
      }

      const hasNoEolAfterLast =
        lastContextOrPlusIdx >= 0 && body[lastContextOrPlusIdx + 1]?.kind === 'backslash';

      cur.hunks.push({
        A,
        C,
        body,
        O,
        N,
        hasNoEolAfterLast,
      });

      i = j;
      continue;
    }

    i++;
  }

  if (cur !== null) {
    sections.push(cur);
  }

  return sections;
}

function applyUnifiedHunks(
  doc: FileDoc,
  hunks: UnifiedHunk[],
  targetPath: string,
  strict: boolean
): void {
  let d = 0;
  for (const hunk of hunks) {
    const { A, O, N, hasNoEolAfterLast } = hunk;
    if (O.length > 0) {
      const occRes = findOccurrences(doc.lines, O, strict);
      if (occRes === null) throw new Fail('no-match', targetPath);
      const target = A - 1 + d;
      let bestPos = occRes.occurrences[0];
      let bestDist = Math.abs(bestPos - target);
      for (let k = 1; k < occRes.occurrences.length; k++) {
        const pos = occRes.occurrences[k];
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const tier = occRes.tier;
      const F = (doc.lines[bestPos] ?? '').match(/^[ \t]*/)?.[0] ?? '';
      const P = O[0].match(/^[ \t]*/)?.[0] ?? '';
      const replacement: string[] = N.map((item) => {
        if (item.isContext) {
          return doc.lines[bestPos + item.contextOIndex!];
        }
        if (tier === 2) {
          return reindentTier2(item.text, F, P);
        }
        return item.text;
      });
      const matchedToEnd = bestPos + O.length === doc.lines.length;
      doc.lines.splice(bestPos, O.length, ...replacement);
      if (matchedToEnd) {
        doc.hasFinalBreak = !hasNoEolAfterLast;
      }
    } else {
      const insertIdx = Math.max(0, Math.min(doc.lines.length, A + d));
      const replacement = N.map((item) => item.text);
      const insertedAtEnd = insertIdx === doc.lines.length;
      doc.lines.splice(insertIdx, 0, ...replacement);
      if (insertedAtEnd) {
        doc.hasFinalBreak = !hasNoEolAfterLast;
      }
    }
    d += N.length - O.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  const edits: Edit[] = [];

  for (const section of sections) {
    const isCreation = section.isCreation || section.oldPath === '/dev/null';
    const isDeletion = section.isDeletion || section.newPath === '/dev/null';
    const isMove =
      !isCreation &&
      !isDeletion &&
      section.oldPath !== null &&
      section.newPath !== null &&
      section.oldPath !== section.newPath;

    if (isCreation) {
      const targetPath = section.newPath!;
      edits.push((tree: Tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) !== null) throw new Fail('exists', targetPath);
        const plusLines: string[] = [];
        let lastPlusHadBackslash = false;
        for (const hunk of section.hunks) {
          for (let bIdx = 0; bIdx < hunk.body.length; bIdx++) {
            if (hunk.body[bIdx].kind === 'new') {
              plusLines.push(hunk.body[bIdx].text);
              lastPlusHadBackslash = hunk.body[bIdx + 1]?.kind === 'backslash';
            }
          }
        }
        const content =
          plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusHadBackslash ? '' : '\n');
        tree.now.set(targetPath, content);
      });
    } else if (isDeletion) {
      const targetPath = section.oldPath!;
      edits.push((tree: Tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) === null) throw new Fail('missing', targetPath);
        tree.now.set(targetPath, null);
      });
    } else if (isMove) {
      const oldPath = section.oldPath!;
      const newPath = section.newPath!;
      edits.push((tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = parseFileDoc(before);
        applyUnifiedHunks(doc, section.hunks, oldPath, strict);
        const result = stringifyFileDoc(doc);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, result);
        tree.moves.push([oldPath, newPath]);
      });
    } else {
      const targetPath = (section.newPath ?? section.oldPath)!;
      edits.push((tree: Tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        const before = tree.get(targetPath);
        if (before === null) throw new Fail('missing', targetPath);
        const doc = parseFileDoc(before);
        applyUnifiedHunks(doc, section.hunks, targetPath, strict);
        tree.now.set(targetPath, stringifyFileDoc(doc));
      });
    }
  }

  return edits;
}

// Section 8 - V4A patches
interface V4AChunk {
  anchor: string | null;
  O: string[];
  N: Array<{ isContext: boolean; contextOIndex?: number; text: string }>;
  isEof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank === -1) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank].trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  }

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      lastNonBlank = i;
      break;
    }
  }
  if (lines[lastNonBlank].trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  interface RawSection {
    type: 'add' | 'delete' | 'update';
    path: string;
    headerLineNum: number;
    rawLines: Array<{ text: string; lineNum: number }>;
  }

  const sections: RawSection[] = [];
  let cur: RawSection | null = null;

  for (let i = firstNonBlank + 1; i < lastNonBlank; i++) {
    const l = lines[i];
    const lineNum = i + 1;
    if (l.startsWith('*** Add File: ')) {
      if (cur !== null) {
        while (cur.rawLines.length > 0 && blank(cur.rawLines[cur.rawLines.length - 1].text)) {
          cur.rawLines.pop();
        }
      }
      cur = {
        type: 'add',
        path: l.slice('*** Add File: '.length).trim(),
        headerLineNum: lineNum,
        rawLines: [],
      };
      sections.push(cur);
    } else if (l.startsWith('*** Delete File: ')) {
      if (cur !== null) {
        while (cur.rawLines.length > 0 && blank(cur.rawLines[cur.rawLines.length - 1].text)) {
          cur.rawLines.pop();
        }
      }
      cur = {
        type: 'delete',
        path: l.slice('*** Delete File: '.length).trim(),
        headerLineNum: lineNum,
        rawLines: [],
      };
      sections.push(cur);
    } else if (l.startsWith('*** Update File: ')) {
      if (cur !== null) {
        while (cur.rawLines.length > 0 && blank(cur.rawLines[cur.rawLines.length - 1].text)) {
          cur.rawLines.pop();
        }
      }
      cur = {
        type: 'update',
        path: l.slice('*** Update File: '.length).trim(),
        headerLineNum: lineNum,
        rawLines: [],
      };
      sections.push(cur);
    } else if (cur === null) {
      if (!blank(l)) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
    } else {
      cur.rawLines.push({ text: l, lineNum });
    }
  }

  if (cur !== null) {
    while (cur.rawLines.length > 0 && blank(cur.rawLines[cur.rawLines.length - 1].text)) {
      cur.rawLines.pop();
    }
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.type === 'add') {
      const fileLines: string[] = [];
      for (const rl of s.rawLines) {
        if (rl.text.startsWith('+')) {
          fileLines.push(rl.text.slice(1));
        } else if (rl.text === '') {
          fileLines.push('');
        } else {
          throw new Exit2(`error: parse ${rl.lineNum}`);
        }
      }
      const p = s.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
        tree.now.set(p, content);
      });
    } else if (s.type === 'delete') {
      for (const rl of s.rawLines) {
        if (!blank(rl.text)) {
          throw new Exit2(`error: parse ${rl.lineNum}`);
        }
      }
      const p = s.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveToPath: string | null = null;
      let startIdx = 0;
      if (s.rawLines.length > 0 && s.rawLines[0].text.startsWith('*** Move to: ')) {
        moveToPath = s.rawLines[0].text.slice('*** Move to: '.length).trim();
        startIdx = 1;
      }
      for (let k = startIdx; k < s.rawLines.length; k++) {
        if (s.rawLines[k].text.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${s.rawLines[k].lineNum}`);
        }
      }

      const chunks: V4AChunk[] = [];
      let currentChunk: V4AChunk | null = null;
      let chunkIsOpen = false;

      for (let k = startIdx; k < s.rawLines.length; k++) {
        const { text, lineNum } = s.rawLines[k];
        if (text.startsWith('@@')) {
          if (chunkIsOpen) {
            chunks.push(currentChunk!);
            chunkIsOpen = false;
          }
          const anchorText = text.slice(2).trim();
          currentChunk = {
            anchor: anchorText === '' ? null : anchorText,
            O: [],
            N: [],
            isEof: false,
          };
          chunkIsOpen = true;
        } else if (text === '*** End of File') {
          if (!chunkIsOpen) {
            throw new Exit2(`error: parse ${lineNum}`);
          }
          currentChunk!.isEof = true;
          chunks.push(currentChunk!);
          currentChunk = null;
          chunkIsOpen = false;
        } else if (
          text.startsWith(' ') ||
          text.startsWith('-') ||
          text.startsWith('+') ||
          text === ''
        ) {
          if (!chunkIsOpen) {
            if (chunks.length === 0) {
              currentChunk = {
                anchor: null,
                O: [],
                N: [],
                isEof: false,
              };
              chunkIsOpen = true;
            } else {
              throw new Exit2(`error: parse ${lineNum}`);
            }
          }
          if (text === '') {
            const oIdx = currentChunk!.O.length;
            currentChunk!.O.push('');
            currentChunk!.N.push({ isContext: true, contextOIndex: oIdx, text: '' });
          } else if (text.startsWith(' ')) {
            const oIdx = currentChunk!.O.length;
            const content = text.slice(1);
            currentChunk!.O.push(content);
            currentChunk!.N.push({ isContext: true, contextOIndex: oIdx, text: content });
          } else if (text.startsWith('-')) {
            currentChunk!.O.push(text.slice(1));
          } else if (text.startsWith('+')) {
            currentChunk!.N.push({ isContext: false, text: text.slice(1) });
          }
        } else {
          throw new Exit2(`error: parse ${lineNum}`);
        }
      }

      if (chunkIsOpen) {
        chunks.push(currentChunk!);
        chunkIsOpen = false;
      }

      if (chunks.length === 0 && moveToPath === null) {
        throw new Exit2(`error: parse ${s.headerLineNum}`);
      }

      const p = s.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveToPath !== null && !safe(moveToPath)) throw new Fail('unsafe', moveToPath);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveToPath !== null && tree.get(moveToPath) !== null)
          throw new Fail('exists', moveToPath);

        const doc = parseFileDoc(before);
        let cursor = 0;
        const maxTier = strict ? 0 : 2;

        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            let anchorLine = -1;
            for (let t = 0; t <= maxTier; t++) {
              for (let k = cursor; k < doc.lines.length; k++) {
                if (lineMatch(doc.lines[k], chunk.anchor, t)) {
                  anchorLine = k;
                  break;
                }
              }
              if (anchorLine >= 0) break;
            }
            if (anchorLine < 0) throw new Fail('no-match', p);
            cursor = anchorLine + 1;
          }

          if (chunk.O.length > 0) {
            let matchedTier = -1;
            let matchedPos = -1;
            for (let t = 0; t <= maxTier; t++) {
              const occ = findOccurrencesAtTier(doc.lines, chunk.O, t);
              const qual = occ.filter(
                (idx) =>
                  idx >= cursor && (!chunk.isEof || idx + chunk.O.length === doc.lines.length)
              );
              if (qual.length > 0) {
                matchedTier = t;
                matchedPos = qual[0];
                break;
              }
            }
            if (matchedPos < 0) throw new Fail('no-match', p);
            const F = (doc.lines[matchedPos] ?? '').match(/^[ \t]*/)?.[0] ?? '';
            const P = chunk.O[0].match(/^[ \t]*/)?.[0] ?? '';
            const replacement = chunk.N.map((item) => {
              if (item.isContext) {
                return doc.lines[matchedPos + item.contextOIndex!];
              }
              if (matchedTier === 2) {
                return reindentTier2(item.text, F, P);
              }
              return item.text;
            });
            doc.lines.splice(matchedPos, chunk.O.length, ...replacement);
            cursor = matchedPos + replacement.length;
          } else {
            const replacement = chunk.N.map((item) => item.text);
            if (chunk.isEof) {
              doc.lines.push(...replacement);
              cursor = doc.lines.length;
            } else {
              doc.lines.splice(cursor, 0, ...replacement);
              cursor = cursor + replacement.length;
            }
          }
        }

        const result = stringifyFileDoc(doc);
        if (moveToPath !== null) {
          tree.now.set(p, null);
          tree.now.set(moveToPath, result);
          tree.moves.push([p, moveToPath]);
        } else {
          tree.now.set(p, result);
        }
      });
    }
  }

  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9)))
        format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'search-replace') {
      edits = searchReplaceEdits(lines, strict);
    } else if (kind === 'unified') {
      edits = unifiedEdits(lines, strict);
    } else if (kind === 'v4a') {
      edits = v4aEdits(lines, strict);
    } else {
      edits = [];
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }

  if (fails.length > 0)
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };

  const pathRows = new Map<string, { type: 'A' | 'D' | 'M'; path: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    pathRows.set(p, {
      type: was === null ? 'A' : now === null ? 'D' : 'M',
      path: p,
    });
  }

  interface RowItem {
    sortKey: string;
    line: string;
  }
  const rows: RowItem[] = [];

  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.now.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.now.get(newP) !== null
    ) {
      if (pathRows.get(oldP)?.type === 'D' && pathRows.get(newP)?.type === 'A') {
        pathRows.delete(oldP);
        pathRows.delete(newP);
        rows.push({
          sortKey: newP,
          line: `R ${oldP} -> ${newP}`,
        });
      }
    }
  }

  for (const [p, item] of pathRows) {
    rows.push({
      sortKey: p,
      line: `${item.type} ${p}`,
    });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => r.line);

  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  return {
    code: 0,
    out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
