// Lecture des journaux de conversation de Copilot Chat (format non documenté par VS Code).
// Le parseur est volontairement tolérant : il cherche les objets « requête » (qui ont un
// requestId) n'importe où dans le fichier, en .json (instantané) comme en .jsonl (journal
// de modifications rejoué).
import * as fs from 'fs';
import * as path from 'path';

export interface ParsedRequest {
  requestId: string;
  timestamp: number;
  model: string;
  multiplier: number | undefined;
  credits: number | undefined; // crédits IA journalisés par Copilot pour ce tour, si présents
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  measured: boolean;
  messageText: string;
  inlineTask: string | undefined;
  editedFiles: string[];
  referencedFiles: string[];
  completed: boolean;
}

export interface ParsedSession {
  sessionId: string;
  file: string;
  title: string;
  lastActivity: number;
  requests: ParsedRequest[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IN_KEYS = ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens'];
const OUT_KEYS = ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens'];
const CACHE_WRITE_KEYS = ['cacheWriteTokens', 'cacheCreationTokens', 'cache_creation_input_tokens', 'cache_write_tokens', 'cacheCreationInputTokens'];
const CACHE_KEYS = ['cachedTokens', 'cached_tokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cachedPromptTokens'];
const SKIP_TEXT_KEYS = new Set(['$mid', 'uri', 'fsPath', 'external', 'path', 'scheme', 'authority', 'query', 'fragment', 'id', 'requestId', 'responseId', 'sessionId', 'kind']);

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null;
}

function getPath(root: Json, keys: (string | number)[]): Json {
  let cur = root;
  for (const k of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[k as string];
  }
  return cur;
}

/** Rejoue un journal .jsonl (kind 0 = état initial, 1 = set, 2 = push, 3 = delete). */
function replay(lines: Json[]): Json {
  let state: Json = undefined;
  for (const l of lines) {
    if (!isObj(l) || typeof l.kind !== 'number') continue;
    if (l.kind === 0) {
      state = l.v;
      continue;
    }
    if (state === undefined || !Array.isArray(l.k) || l.k.length === 0) continue;
    const parent = getPath(state, l.k.slice(0, -1));
    const key = l.k[l.k.length - 1];
    if (!isObj(parent)) continue;
    if (l.kind === 1) {
      parent[key] = l.v;
    } else if (l.kind === 2) {
      let arr = parent[key];
      if (!Array.isArray(arr)) {
        arr = [];
        parent[key] = arr;
      }
      if (typeof l.i === 'number') arr.length = Math.min(arr.length, l.i);
      if (Array.isArray(l.v)) arr.push(...l.v);
      else if (l.v !== undefined) arr.push(l.v);
    } else if (l.kind === 3) {
      delete parent[key];
    }
  }
  return state;
}

function findRequests(root: Json): Record<string, Json>[] {
  const byId = new Map<string, Record<string, Json>>();
  const walk = (v: Json, depth: number) => {
    if (depth > 14 || !isObj(v)) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v.requestId === 'string' && ('message' in v || 'response' in v || 'result' in v)) {
      const prev = byId.get(v.requestId);
      byId.set(v.requestId, prev ? Object.assign(prev, v) : { ...v });
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return [...byId.values()];
}

export function loadRoot(file: string): Json {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.jsonl')) {
    const lines: Json[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        lines.push(JSON.parse(t));
      } catch {
        // ligne en cours d'écriture : ignorée, elle sera relue au prochain passage
      }
    }
    const state = replay(lines);
    if (state !== undefined && findRequests(state).length > 0) return state;
    return { __lines: lines, sessionId: isObj(state) ? state.sessionId : undefined };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function textLength(v: Json, depth = 0): number {
  if (depth > 14 || v === null || v === undefined) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x: Json) => n + textLength(x, depth + 1), 0);
  if (isObj(v)) {
    let n = 0;
    for (const k of Object.keys(v)) if (!SKIP_TEXT_KEYS.has(k)) n += textLength(v[k], depth + 1);
    return n;
  }
  return 0;
}

function collectFiles(v: Json, out: Set<string>, depth = 0): void {
  if (depth > 14 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    if (v.startsWith('file:///')) out.add(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectFiles(x, out, depth + 1);
    return;
  }
  if (isObj(v)) {
    if (v.scheme === 'file' && (typeof v.fsPath === 'string' || typeof v.path === 'string')) {
      out.add(typeof v.fsPath === 'string' ? v.fsPath : 'file://' + v.path);
      return;
    }
    for (const k of Object.keys(v)) collectFiles(v[k], out, depth + 1);
  }
}

function findUsage(v: Json): { i: number; o: number; c: number; w: number } | undefined {
  const hits: { depth: number; i: number; o: number; c: number; w: number }[] = [];
  const num = (o: Record<string, Json>, keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'number') return o[k] as number;
    return undefined;
  };
  const walk = (x: Json, depth: number) => {
    if (depth > 12 || !isObj(x)) return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
      return;
    }
    const i = num(x, IN_KEYS);
    const o = num(x, OUT_KEYS);
    if (i !== undefined || o !== undefined) {
      let c = num(x, CACHE_KEYS) ?? 0;
      const det = x.prompt_tokens_details ?? x.promptTokensDetails;
      let w = num(x, CACHE_WRITE_KEYS) ?? 0;
      if (!c && isObj(det)) c = num(det, CACHE_KEYS) ?? 0;
      if (!w && isObj(det)) w = num(det, CACHE_WRITE_KEYS) ?? 0;
      hits.push({ depth, i: i ?? 0, o: o ?? 0, c, w });
      return;
    }
    for (const k of Object.keys(x)) walk(x[k], depth + 1);
  };
  walk(v, 0);
  if (!hits.length) return undefined;
  // On garde le niveau le moins profond pour éviter de compter un total ET ses détails.
  const min = Math.min(...hits.map((h) => h.depth));
  return hits
    .filter((h) => h.depth === min)
    .reduce((a, h) => ({ i: a.i + h.i, o: a.o + h.o, c: a.c + h.c, w: a.w + h.w }), { i: 0, o: 0, c: 0, w: 0 });
}

const CREDIT_KEY = /credit/i;
const CREDIT_EXCLUDE = /remain|quota|limit|allow|balance|left|entitle|reset/i;

/** Crédits consommés journalisés dans la requête (clé contenant « credit »), au niveau le moins profond. */
function findCredits(v: Json): number | undefined {
  const hits: { depth: number; n: number }[] = [];
  const walk = (x: Json, depth: number) => {
    if (depth > 10 || !isObj(x)) return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
      return;
    }
    for (const k of Object.keys(x)) {
      const val = x[k];
      if (typeof val === 'number' && CREDIT_KEY.test(k) && !CREDIT_EXCLUDE.test(k)) hits.push({ depth, n: val });
      else walk(val, depth + 1);
    }
  };
  walk(v, 0);
  if (!hits.length) return undefined;
  const min = Math.min(...hits.map((h) => h.depth));
  return hits.filter((h) => h.depth === min).reduce((a, h) => a + h.n, 0);
}

export function parseSessionFile(file: string, charsPerToken: number): ParsedSession | undefined {
  const root = loadRoot(file);
  if (root === undefined) return undefined;
  const stat = fs.statSync(file);
  const cpt = charsPerToken > 0 ? charsPerToken : 4;
  const est = (n: number) => Math.ceil(n / cpt);

  const reqs = findRequests(root);
  reqs.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));

  const sessionId =
    isObj(root) && typeof root.sessionId === 'string' && root.sessionId
      ? root.sessionId
      : path.basename(file).replace(/\.jsonl?$/i, '');

  let history = 0;
  let inlineTask: string | undefined;
  let lastTs = 0;
  const requests: ParsedRequest[] = [];

  for (const r of reqs) {
    const msg: string =
      isObj(r.message) && typeof r.message.text === 'string'
        ? r.message.text
        : typeof r.message === 'string'
          ? r.message
          : '';
    const tag = /#task:\s*([^\s#]+)/i.exec(msg);
    if (tag) inlineTask = tag[1];

    const meta = isObj(r.result) ? r.result.metadata : undefined;
    const respChars = textLength(r.response);
    const roundsChars = textLength(isObj(meta) ? meta.toolCallRounds : undefined);
    const toolResultsChars = textLength(isObj(meta) ? meta.toolCallResults : undefined);
    const varsChars = textLength(r.variableData);

    const usage = findUsage({ result: r.result, usage: r.usage });
    const inputTokens = usage ? usage.i : est(history + msg.length + varsChars + toolResultsChars);
    const outputTokens = usage ? usage.o : est(respChars + roundsChars);
    const cachedTokens = usage ? Math.min(usage.c, usage.i || usage.c) : 0;
    const cacheWriteTokens = usage ? usage.w : 0;
    history += msg.length + respChars;

    const details = isObj(r.result) && typeof r.result.details === 'string' ? r.result.details : '';
    const mult = /(\d+(?:[.,]\d+)?)\s*x\b/i.exec(details);
    const credInDetails = /(\d+(?:[.,]\d+)?)\s*(?:ai\s*)?cr[ée]dits?/i.exec(details);
    const credits = credInDetails ? Number(credInDetails[1].replace(',', '.')) : findCredits({ result: r.result, usage: r.usage });
    const model =
      typeof r.modelId === 'string' && r.modelId
        ? r.modelId.replace(/^copilot\//, '')
        : details.split('•')[0].trim() || 'inconnu';

    const edited = new Set<string>();
    const referenced = new Set<string>();
    if (Array.isArray(r.response)) {
      for (const part of r.response) {
        if (isObj(part) && /EditGroup$|codeblockUri/i.test(String(part.kind ?? ''))) collectFiles(part.uri ?? part, edited);
      }
    }
    collectFiles(r, referenced);
    for (const f of edited) referenced.delete(f);

    const ts = typeof r.timestamp === 'number' ? r.timestamp : stat.mtimeMs;
    lastTs = Math.max(lastTs, ts);

    requests.push({
      requestId: r.requestId,
      timestamp: ts,
      model,
      multiplier: mult ? Number(mult[1].replace(',', '.')) : undefined,
      credits,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      measured: !!usage,
      messageText: msg,
      inlineTask,
      editedFiles: [...edited],
      referencedFiles: [...referenced],
      completed: (r.result !== undefined && r.result !== null) || r.isCanceled === true,
    });
  }

  const custom = isObj(root) && typeof root.customTitle === 'string' ? root.customTitle : '';
  const first = requests[0]?.messageText ?? '';
  return {
    sessionId,
    file,
    title: (custom || first).replace(/\s+/g, ' ').trim().slice(0, 80),
    lastActivity: Math.max(lastTs, stat.mtimeMs),
    requests,
  };
}
