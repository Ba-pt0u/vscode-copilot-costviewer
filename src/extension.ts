import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSessionFile, ParsedSession, ParsedRequest } from './parser';
import { CsvStore, CsvRow } from './csv';
import { tokenCost, multiplierFor, PriceEntry, priceFromModel } from './costs';

interface SessionMeta {
  task?: string; // tag posé avec la commande (prioritaire sur #task: dans les messages)
  root?: string; // dossier projet épinglé (le fichier de coûts est dedans)
  manual?: boolean; // dossier choisi à la main avec la commande de tag
}

interface Target {
  root: string;
  project: string;
  relPath: string;
}

let ctx: vscode.ExtensionContext;
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;
let timer: NodeJS.Timeout | undefined;
let busy = false;
let lastError: string | undefined;
let lastFlush: Date | undefined;
let lastWritten = 0;
let askTimer: NodeJS.Timeout | undefined;
const RECALC_KEYS = [
  'granularity', 'folderDepth', 'excludedFolders', 'modelPrices', 'premiumRequestPrice', 'modelMultipliers',
  'costBasis', 'currency', 'creditPrice', 'priceSource', 'longContextThreshold', 'decimalSeparator', 'defaultTask', 'includeConversationTitle', 'charsPerToken',
];
let store: CsvStore;
const sessionCache = new Map<string, { mtime: number; size: number; session: ParsedSession | undefined }>();

const cfg = () => vscode.workspace.getConfiguration('copilotCosts');
const isWin = process.platform === 'win32';
const samePath = (a: string, b: string) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
const log = (m: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);

// ---------------------------------------------------------------- état

function getMeta(): Record<string, SessionMeta> {
  return ctx.workspaceState.get<Record<string, SessionMeta>>('sessions', {});
}

async function patchMeta(patch: Record<string, SessionMeta>): Promise<void> {
  const all = { ...getMeta() };
  for (const [id, m] of Object.entries(patch)) all[id] = { ...all[id], ...m };
  await ctx.workspaceState.update('sessions', all);
}

// ---------------------------------------------------------------- sessions

function sessionsDir(): string | undefined {
  const forced = cfg().get<string>('chatSessionsPath', '').trim();
  if (forced) return forced;
  if (!ctx.storageUri) return undefined;
  // storageUri = …/workspaceStorage/<hash>/<extension> → les sessions sont dans …/<hash>/chatSessions
  return path.join(path.dirname(ctx.storageUri.fsPath), 'chatSessions');
}

function scanSessions(): ParsedSession[] {
  const dir = sessionsDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const cpt = cfg().get<number>('charsPerToken', 4);
  const result: ParsedSession[] = [];
  const seen = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    if (!/\.jsonl?$/i.test(name)) continue;
    const file = path.join(dir, name);
    seen.add(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const c = sessionCache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) {
      if (c.session) result.push(c.session);
      continue;
    }
    let s: ParsedSession | undefined;
    try {
      s = parseSessionFile(file, cpt);
    } catch (e) {
      log(`Lecture impossible de ${name} : ${(e as Error).message}`);
    }
    sessionCache.set(file, { mtime: st.mtimeMs, size: st.size, session: s });
    if (s) result.push(s);
  }
  for (const k of [...sessionCache.keys()]) if (!seen.has(k)) sessionCache.delete(k);
  return result;
}

// ---------------------------------------------------------------- projets

function workspaceRoot(): string | undefined {
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme === 'file') return path.dirname(wf.fsPath);
  const f = vscode.workspace.workspaceFolders?.find((x) => x.uri.scheme === 'file');
  return f?.uri.fsPath;
}

function rootFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function toFsPath(s: string): string | undefined {
  try {
    if (s.startsWith('file:')) return vscode.Uri.parse(s).fsPath;
    if (path.isAbsolute(s)) return path.normalize(s);
  } catch {
    /* ignoré */
  }
  return undefined;
}

/** Dossier projet d'un fichier selon la profondeur configurée, ou undefined. */
function projectFolderOf(file: string): string | undefined {
  const depth = Math.max(0, cfg().get<number>('folderDepth', 1));
  const excluded = cfg().get<string[]>('excludedFolders', []).map((x) => x.toLowerCase());
  for (const root of rootFolders()) {
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (depth === 0) return root;
    const segs = rel.split(path.sep);
    if (segs.length <= depth) return undefined; // fichier à la racine : pas de dossier projet
    const head = segs.slice(0, depth);
    if (head.some((h) => excluded.includes(h.toLowerCase()))) return undefined;
    return path.join(root, ...head);
  }
  return undefined;
}

function detectFolder(s: ParsedSession): string | undefined {
  const score = new Map<string, number>();
  const add = (files: string[], w: number) => {
    for (const f of files) {
      const p = toFsPath(f);
      const folder = p && projectFolderOf(p);
      if (folder) score.set(folder, (score.get(folder) ?? 0) + w);
    }
  };
  for (const r of s.requests) {
    add(r.editedFiles, 3);
    add(r.referencedFiles, 1);
  }
  let best: string | undefined;
  let bestScore = 0;
  for (const [f, n] of score) if (n > bestScore) [best, bestScore] = [f, n];
  return best;
}

function resolveTarget(s: ParsedSession, m: SessionMeta, force = false): Target | 'wait' | undefined {
  const ws = workspaceRoot();
  if (!ws) return undefined;
  let root = m.root;
  if (!root) {
    if (cfg().get<string>('granularity', 'workspace') === 'folder') {
      root = detectFolder(s);
      if (!root) {
        const waitMs = cfg().get<number>('waitForFolderMinutes', 15) * 60_000;
        if (!force && Date.now() - s.lastActivity < waitMs) return 'wait';
        root = ws;
      }
    } else root = ws;
  }
  return { root, project: path.basename(root), relPath: path.relative(ws, root) || '.' };
}

function csvPathFor(root: string): string {
  return path.join(root, cfg().get<string>('fileName', 'copilot-costs.csv'));
}

// ---------------------------------------------------------------- lignes

const pad = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- tarifs

let vscodePrices: Record<string, PriceEntry> = {};
let pricesLoadedAt = 0;

/** Tarifs en vigueur : ceux de VS Code (si activé) complètent/remplacent ceux des réglages. */
function priceTable(): Record<string, PriceEntry> {
  const settings = cfg().get<Record<string, PriceEntry>>('modelPrices', {});
  return cfg().get<string>('priceSource', 'vscode') === 'vscode' ? { ...settings, ...vscodePrices } : settings;
}

/** Lit les tarifs exposés par les modèles Copilot (vscode.lm). Retourne vrai s'ils ont changé. */
async function loadVscodePrices(logIt = false): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lm = (vscode as any).lm;
  if (!lm?.selectChatModels) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let models: any[] = [];
  try {
    models = await lm.selectChatModels({ vendor: 'copilot' });
  } catch (e) {
    log(`Lecture des modèles impossible : ${(e as Error).message}`);
    return false;
  }
  const found: Record<string, PriceEntry> = {};
  for (const m of models) {
    const p = priceFromModel(m);
    if (logIt) out.appendLine(`• ${m.name} [id ${m.id} · famille ${m.family}] ${p ? `in ${p.input} · out ${p.output} · cache ${p.cached ?? '-'} · écriture cache ${p.cacheWrite ?? '-'}${p.longInput !== undefined ? ` · long context in ${p.longInput} · out ${p.longOutput}` : ''}` : 'pas de tarif'}`);
    if (!p) continue;
    // Clés : identifiant, famille et version (ex. « auto », « copilot-utility » → modèle réel).
    for (const k of [m.version, m.family, m.id]) if (typeof k === 'string' && k) found[k] = p;
  }
  // Modèles sans tarif propre (ex. « Auto ») : tarif de leur famille si connu.
  for (const m of models) if (!priceFromModel(m) && typeof m.id === 'string' && !found[m.id] && found[m.family]) found[m.id] = found[m.family];
  pricesLoadedAt = Date.now();
  if (!Object.keys(found).length) return false;
  const before = JSON.stringify(vscodePrices);
  vscodePrices = found;
  const hash = JSON.stringify(Object.keys(found).sort().map((k) => [k, found[k]]));
  const prev = ctx.globalState.get<string>('pricesHash');
  await ctx.globalState.update('pricesHash', hash);
  if (before !== JSON.stringify(found)) log(`${models.length} modèle(s), tarifs VS Code chargés.`);
  return prev !== undefined && prev !== hash;
}

function costs(r: ParsedRequest) {
  const c = cfg();
  // Crédits : ceux journalisés par Copilot s'ils existent, sinon tokens × tarif du modèle (crédits / 1M tokens).
  const computed = tokenCost(r, priceTable(), c.get<number>('longContextThreshold', 272000));
  const credits = r.credits ?? computed;
  const tCost = credits * c.get<number>('creditPrice', 0.01);
  const mult = multiplierFor(r, c.get<Record<string, number>>('modelMultipliers', {}));
  const pCost = mult * c.get<number>('premiumRequestPrice', 0.04);
  const main = c.get<string>('costBasis', 'tokens') === 'premiumRequests' ? pCost : tCost;
  return { credits, creditsLogged: r.credits !== undefined, tCost, mult, pCost, main };
}

function buildRow(s: ParsedSession, r: ParsedRequest, m: SessionMeta, t: Target): CsvRow {
  const c = cfg();
  const dec = c.get<string>('decimalSeparator', ',');
  const num = (n: number, d: number) => n.toFixed(d).replace('.', dec);
  const d = new Date(r.timestamp);
  const k = costs(r);
  const rec: Record<string, string> = {
    'Date': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    'Heure': `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    'Mois': `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    'Utilisateur': os.userInfo().username,
    'Workspace': vscode.workspace.name ?? '',
    'Projet': t.project,
    'Chemin projet': t.relPath,
    'Tâche': m.task || r.inlineTask || c.get<string>('defaultTask', 'non-tagué'),
    'Conversation': c.get<boolean>('includeConversationTitle', true) ? s.title : '',
    'ID session': s.sessionId,
    'ID requête': r.requestId,
    'Modèle': r.model,
    'Multiplicateur': num(k.mult, 2),
    'Tokens entrée': String(r.inputTokens),
    'Tokens cache': String(r.cachedTokens),
    'Tokens écriture cache': String(r.cacheWriteTokens),
    'Tokens sortie': String(r.outputTokens),
    'Tokens total': String(r.inputTokens + r.outputTokens),
    'Source tokens': r.measured ? 'mesuré' : 'estimé',
    'Crédits': num(k.credits, 4),
    'Source crédits': k.creditsLogged ? 'journal Copilot' : 'calculé',
    'Requêtes premium': num(k.mult, 2),
    'Coût tokens': num(k.tCost, 6),
    'Coût requêtes premium': num(k.pCost, 6),
    'Coût': num(k.main, 6),
    'Devise': c.get<string>('currency', 'USD'),
  };
  return { key: `${s.sessionId}|${r.requestId}`, rec };
}

// ---------------------------------------------------------------- écriture

async function flush(reason: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await flushCore(reason, false);
  } finally {
    busy = false;
  }
}

async function flushCore(reason: string, force: boolean): Promise<void> {
  try {
    if (Date.now() - pricesLoadedAt > 30 * 60_000) {
      const changed = await loadVscodePrices();
      if (changed && cfg().get<string>('priceSource', 'vscode') === 'vscode') void offerRebuild('Les tarifs des modèles Copilot ont changé dans VS Code.');
    }
    const sessions = scanSessions();
    const meta = getMeta();
    const since = cfg().get<boolean>('importHistory', true) ? 0 : ctx.globalState.get<number>('installedAt', 0);
    const groups = new Map<string, CsvRow[]>();
    const pins: Record<string, SessionMeta> = {};
    let waiting = 0;

    for (const s of sessions) {
      const done = s.requests.filter((r) => r.completed && r.timestamp >= since);
      if (!done.length) continue;
      const m = meta[s.sessionId] ?? {};
      const t = resolveTarget(s, m, force);
      if (t === 'wait') {
        waiting++;
        continue;
      }
      if (!t) continue;
      const csv = csvPathFor(t.root);
      const rows = groups.get(csv) ?? [];
      for (const r of done) rows.push(buildRow(s, r, m, t));
      groups.set(csv, rows);
      if (!m.root) pins[s.sessionId] = { root: t.root };
    }

    let written = 0;
    const errors: string[] = [];
    const failed = new Set<string>();
    for (const [csv, rows] of groups) {
      try {
        written += store.append(csv, rows);
      } catch (e) {
        failed.add(csv);
        const code = (e as NodeJS.ErrnoException).code;
        errors.push(
          code === 'EBUSY' || code === 'EPERM'
            ? `${path.basename(path.dirname(csv))}/${path.basename(csv)} est verrouillé (ouvert dans Excel ?) : nouvel essai au prochain passage.`
            : `${csv} : ${(e as Error).message}`,
        );
      }
    }
    // On n'épingle que les conversations dont le fichier a pu être écrit.
    for (const [id, p] of Object.entries(pins)) if (p.root && failed.has(csvPathFor(p.root))) delete pins[id];
    if (Object.keys(pins).length) await patchMeta(pins);

    lastError = errors.length ? errors.join('\n') : undefined;
    lastFlush = new Date();
    lastWritten = written;
    if (written || errors.length) log(`${reason} : ${written} ligne(s) écrite(s)${waiting ? `, ${waiting} conversation(s) en attente de dossier` : ''}${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
    updateStatus(sessions);
  } catch (e) {
    lastError = (e as Error).message;
    log(`Erreur : ${lastError}`);
  }
}

// ---------------------------------------------------------------- recalcul complet

/** Recalcule les colonnes de coût d'une ligne à partir de ses tokens (conversations dont le journal n'existe plus). */
function repriceRow(header: string[], row: string[]): string[] {
  const ix = (n: string) => header.indexOf(n);
  const n = (name: string) => Number((row[ix(name)] ?? '').replace(',', '.')) || 0;
  const dec = cfg().get<string>('decimalSeparator', ',');
  const fmt = (x: number, d: number) => x.toFixed(d).replace('.', dec);
  const multRaw = row[ix('Multiplicateur')];
  const logged = row[ix('Source crédits')] === 'journal Copilot';
  const r = {
    credits: logged ? n('Crédits') : undefined,
    model: row[ix('Modèle')] ?? '',
    inputTokens: n('Tokens entrée'),
    cachedTokens: n('Tokens cache'),
    cacheWriteTokens: n('Tokens écriture cache'),
    outputTokens: n('Tokens sortie'),
    multiplier: multRaw ? n('Multiplicateur') : undefined,
  } as ParsedRequest;
  const { credits, creditsLogged, tCost, mult, pCost, main } = costs(r);
  const outRow = header.map((_, i) => row[i] ?? '');
  const set = (name: string, v: string) => {
    if (ix(name) >= 0) outRow[ix(name)] = v;
  };
  set('Multiplicateur', fmt(mult, 2));
  set('Crédits', fmt(credits, 4));
  set('Source crédits', creditsLogged ? 'journal Copilot' : 'calculé');
  set('Requêtes premium', fmt(mult, 2));
  set('Coût tokens', fmt(tCost, 6));
  set('Coût requêtes premium', fmt(pCost, 6));
  set('Coût', fmt(main, 6));
  set('Devise', cfg().get<string>('currency', 'USD'));
  return outRow;
}

async function rebuild(resetManual: boolean): Promise<void> {
  const ws = workspaceRoot();
  if (!ws) return;
  if (busy) {
    void vscode.window.showWarningMessage('Écriture en cours, réessayez dans quelques secondes.');
    return;
  }
  busy = true;
  try {
    sessionCache.clear();
    const sessions = scanSessions();
    const ids = new Set(sessions.map((s) => s.sessionId));
    const meta = getMeta();
    const wsName = vscode.workspace.name ?? '';

    // Tous les fichiers de coûts connus de ce workspace (ancienne et nouvelle maille).
    const files = new Set<string>([csvPathFor(ws)]);
    for (const m of Object.values(meta)) if (m.root) files.add(csvPathFor(m.root));
    for (const r of rootFolders()) files.add(csvPathFor(r));
    // Aussi les dossiers projets possibles (au cas où l'état de l'extension aurait été perdu).
    const depth = Math.max(0, cfg().get<number>('folderDepth', 1));
    for (const r of rootFolders()) for (const f of listFolders(r, depth)) files.add(csvPathFor(f));
    for (const s of sessions) {
      const f = detectFolder(s);
      if (f) files.add(csvPathFor(f));
    }
    const existing = [...files].filter((f) => fs.existsSync(f));

    const locked = existing.filter((f) => store.isLocked(f));
    if (locked.length) {
      void vscode.window.showErrorMessage(`Fermez d'abord dans Excel : ${locked.map((f) => path.relative(ws, f) || f).join(', ')}`);
      return;
    }

    // 1. Retirer les lignes des conversations encore disponibles (elles seront réécrites),
    //    et recalculer les prix des lignes dont le journal n'existe plus (gardées sur place).
    let removed = 0;
    let repriced = 0;
    for (const f of existing) {
      store.rewrite(
        f,
        (header, rows) => {
          const s = header.indexOf('ID session');
          const w = header.indexOf('Workspace');
          const kept: string[][] = [];
          for (const row of rows) {
            if (s >= 0 && ids.has(row[s])) {
              removed++;
              continue;
            }
            if (w < 0 || row[w] === wsName) {
              kept.push(repriceRow(header, row));
              repriced++;
            } else kept.push(row);
          }
          return kept;
        },
        true,
        true,
      );
    }

    // 2. Oublier les dossiers épinglés automatiquement (et manuels si demandé). Les tâches sont gardées.
    const next: Record<string, SessionMeta> = {};
    for (const [id, m] of Object.entries(meta)) {
      const keepRoot = !resetManual && m.manual && m.root;
      next[id] = { task: m.task, ...(keepRoot ? { root: m.root, manual: true } : {}) };
    }
    await ctx.workspaceState.update('sessions', next);

    // 3. Réécrire tout l'historique disponible avec la maille et les prix actuels.
    await flushCore('Recalcul complet', true);
    const msg = `Recalcul terminé : ${lastWritten} ligne(s) réécrite(s) depuis ${sessions.length} conversation(s)${repriced ? `, ${repriced} ligne(s) d'anciennes conversations (journal supprimé par VS Code) repricées sur place` : ''}. Sauvegardes : *.csv.bak.`;
    log(`${msg} (${removed} ligne(s) retirée(s))`);
    void vscode.window.showInformationMessage(lastError ? `${msg} ⚠ ${lastError}` : msg);
  } catch (e) {
    void vscode.window.showErrorMessage(`Recalcul interrompu : ${(e as Error).message}. Les fichiers d'origine sont dans *.csv.bak.`);
  } finally {
    busy = false;
  }
}

async function rebuildCommand(): Promise<void> {
  const mode = cfg().get<string>('granularity', 'workspace') === 'folder' ? 'par dossier' : 'par workspace';
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(sync) Tout recalculer', detail: `Maille actuelle (${mode}) et prix actuels. Les dossiers choisis à la main et les tâches sont conservés.`, reset: false },
      { label: '$(discard) Tout recalculer et réinitialiser les dossiers', detail: 'Les dossiers choisis à la main sont aussi oubliés (re-détection automatique). Les tâches sont conservées.', reset: true },
    ],
    { placeHolder: 'Recalculer l’historique des coûts de ce workspace' },
  );
  if (!pick) return;
  await rebuild(pick.reset);
}

function updateStatus(sessions: ParsedSession[]): void {
  const now = new Date();
  const month = (ts: number) => {
    const d = new Date(ts);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  };
  const cur = cfg().get<string>('currency', 'USD');
  const dec = cfg().get<string>('decimalSeparator', ',');
  let total = 0;
  let today = 0;
  let tokens = 0;
  let reqs = 0;
  let estimated = 0;
  let credits = 0;
  for (const s of sessions)
    for (const r of s.requests) {
      if (!r.completed || !month(r.timestamp)) continue;
      const k = costs(r);
      const c = k.main;
      credits += k.credits;
      total += c;
      if (new Date(r.timestamp).getDate() === now.getDate()) today += c;
      tokens += r.inputTokens + r.outputTokens;
      reqs++;
      if (!r.measured) estimated++;
    }
  const fmt = (n: number) => n.toFixed(2).replace('.', dec);
  status.text = `${lastError ? '$(warning)' : '$(graph)'} ${fmt(total)} ${cur}`;
  const md = new vscode.MarkdownString(
    `**Copilot – ${vscode.workspace.name ?? 'workspace'}** (estimation)\n\n` +
      `| | |\n|---|---|\n| Aujourd'hui | ${fmt(today)} ${cur} |\n| Ce mois | ${fmt(total)} ${cur} |\n| Crédits (mois) | ${credits.toFixed(0)} |\n| Requêtes (mois) | ${reqs} |\n| Tokens (mois) | ${tokens.toLocaleString('fr-FR')} |\n` +
      (estimated ? `\n_${estimated} requête(s) avec tokens estimés (non journalisés par Copilot)._\n` : '') +
      (lastFlush ? `\nDernière écriture : ${lastFlush.toLocaleTimeString()} (${lastWritten} ligne(s))` : '') +
      (lastError ? `\n\n$(warning) ${lastError}` : '') +
      `\n\nCliquer pour le menu.`,
    true,
  );
  status.tooltip = md;
}

function restartTimer(): void {
  if (timer) clearInterval(timer);
  const min = Math.max(1, cfg().get<number>('flushIntervalMinutes', 5));
  timer = setInterval(() => void flush('Écriture périodique'), min * 60_000);
}

// ---------------------------------------------------------------- commandes

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function listFolders(root: string, depth: number): string[] {
  const excluded = cfg().get<string[]>('excludedFolders', []).map((x) => x.toLowerCase());
  let level = [root];
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory() && !excluded.includes(e.name.toLowerCase())) next.push(path.join(dir, e.name));
      if (next.length > 300) break;
    }
    level = next;
  }
  return level;
}

async function pickFolder(s: ParsedSession, current: string | undefined): Promise<string | undefined> {
  const ws = workspaceRoot()!;
  const depth = Math.max(0, cfg().get<number>('folderDepth', 1));
  const rel = (p: string) => path.relative(ws, p) || '.';
  type Item = vscode.QuickPickItem & { value?: string; browse?: boolean };
  const items: Item[] = [];
  const added: string[] = [];
  const push = (p: string, label: string, description?: string) => {
    if (added.some((a) => samePath(a, p))) return;
    added.push(p);
    items.push({ label, description, value: p });
  };
  const detected = detectFolder(s);
  if (current) push(current, `$(pin) ${rel(current)}`, 'actuel');
  if (detected) push(detected, `$(sparkle) ${rel(detected)}`, 'détecté depuis les fichiers de la conversation');
  push(ws, `$(root-folder) ${path.basename(ws)}`, 'racine du workspace');
  for (const r of depth === 0 ? rootFolders() : rootFolders().flatMap((r) => listFolders(r, depth))) push(r, `$(folder) ${rel(r)}`);
  items.push({ label: '$(folder-opened) Parcourir…', browse: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Dossier projet de cette conversation', matchOnDescription: true });
  if (!pick) return undefined;
  if (!pick.browse) return pick.value;
  const res = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(ws), openLabel: 'Choisir ce dossier projet' });
  return res?.[0]?.fsPath;
}

async function tagSession(): Promise<void> {
  if (!workspaceRoot()) {
    void vscode.window.showWarningMessage('Ouvrez un dossier ou un workspace pour suivre les coûts.');
    return;
  }
  const sessions = scanSessions()
    .filter((s) => s.requests.length)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  if (!sessions.length) {
    void vscode.window.showInformationMessage('Aucune conversation Copilot trouvée pour ce workspace (voir « Copilot Coûts : Diagnostic »).');
    return;
  }
  const meta = getMeta();
  const ws = workspaceRoot()!;
  const pick = await vscode.window.showQuickPick(
    sessions.slice(0, 60).map((s, i) => {
      const m = meta[s.sessionId] ?? {};
      return {
        label: `${i === 0 ? '$(star-full) ' : ''}${s.title || '(sans titre)'}`,
        description: fmtDate(s.lastActivity),
        detail: `Tâche : ${m.task ?? s.requests[s.requests.length - 1]?.inlineTask ?? '—'}  ·  Projet : ${m.root ? path.relative(ws, m.root) || '.' : 'auto'}  ·  ${s.requests.length} requête(s)`,
        s,
      };
    }),
    { placeHolder: 'Conversation à taguer (la plus récente en premier)', matchOnDetail: true },
  );
  if (!pick) return;
  const s = pick.s;
  const m = meta[s.sessionId] ?? {};

  const NEW = '$(add) Nouvelle tâche…';
  const NONE = '$(close) Retirer le tag';
  const known = [...new Set(Object.values(meta).map((x) => x.task).filter((x): x is string => !!x))].sort();
  const taskPick = await vscode.window.showQuickPick([NEW, ...known, ...(m.task ? [NONE] : [])], {
    placeHolder: `Tâche pour « ${s.title.slice(0, 40)} » (actuelle : ${m.task ?? 'aucune'})`,
  });
  if (taskPick === undefined) return;
  let task: string | undefined = taskPick;
  if (taskPick === NONE) task = undefined;
  else if (taskPick === NEW) {
    const v = await vscode.window.showInputBox({ prompt: 'Nom de la tâche', value: m.task ?? '', validateInput: (x) => (x.trim() ? undefined : 'Nom requis') });
    if (v === undefined) return;
    task = v.trim();
  }

  let root = m.root;
  let manual = m.manual;
  if (cfg().get<string>('granularity', 'workspace') === 'folder') {
    const chosen = await pickFolder(s, m.root);
    if (!chosen) return;
    root = chosen;
    manual = true;
  } else root = root ?? ws;

  // Les lignes déjà écrites sont retirées puis réécrites avec la nouvelle tâche / le nouveau dossier.
  if (m.root) {
    const old = csvPathFor(m.root);
    try {
      store.removeSession(old, s.sessionId);
    } catch (e) {
      void vscode.window.showErrorMessage(`Impossible de modifier ${path.basename(old)} (ouvert dans Excel ?). Fermez-le puis réessayez. ${(e as Error).message}`);
      return;
    }
  }
  const all = { ...getMeta() };
  all[s.sessionId] = { task, root, manual };
  await ctx.workspaceState.update('sessions', all);
  await flush('Tag');
  void vscode.window.showInformationMessage(`Conversation taguée : ${task ?? '(sans tâche)'} → ${path.relative(ws, root) || path.basename(root)}`);
}

async function openReport(): Promise<void> {
  const ws = workspaceRoot();
  if (!ws) return;
  const roots = new Set<string>([ws, ...Object.values(getMeta()).map((m) => m.root).filter((x): x is string => !!x)]);
  const files = [...roots].map(csvPathFor).filter((f) => fs.existsSync(f));
  if (!files.length) {
    void vscode.window.showInformationMessage('Aucun fichier de coûts pour le moment. Lancez « Enregistrer les coûts maintenant ».');
    return;
  }
  let file = files[0];
  if (files.length > 1) {
    const p = await vscode.window.showQuickPick(files.map((f) => ({ label: path.relative(ws, f), f })), { placeHolder: 'Fichier de coûts' });
    if (!p) return;
    file = p.f;
  }
  const how = await vscode.window.showQuickPick(['Ouvrir dans Excel (application par défaut)', 'Ouvrir dans VS Code', 'Afficher dans l’Explorateur'], { placeHolder: path.basename(file) });
  if (!how) return;
  if (how.startsWith('Ouvrir dans Excel')) await vscode.env.openExternal(vscode.Uri.file(file));
  else if (how.startsWith('Ouvrir dans VS Code')) await vscode.window.showTextDocument(vscode.Uri.file(file));
  else await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
}

function diagnostics(): void {
  const dir = sessionsDir();
  out.show(true);
  out.appendLine('—— Diagnostic Copilot Coûts ——');
  out.appendLine(`Dossier des sessions : ${dir ?? '(aucun workspace)'} ${dir && fs.existsSync(dir) ? '' : '→ INTROUVABLE'}`);
  out.appendLine(`Racine workspace : ${workspaceRoot() ?? '-'}  ·  maille : ${cfg().get('granularity')}  ·  fichier : ${cfg().get('fileName')}`);
  sessionCache.clear();
  const sessions = scanSessions();
  const reqs = sessions.flatMap((s) => s.requests);
  out.appendLine(`Conversations : ${sessions.length}  ·  requêtes : ${reqs.length}  ·  terminées : ${reqs.filter((r) => r.completed).length}  ·  tokens mesurés : ${reqs.filter((r) => r.measured).length}`);
  const meta = getMeta();
  for (const s of sessions.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 15)) {
    const m = meta[s.sessionId] ?? {};
    const models = [...new Set(s.requests.map((r) => r.model))].join(', ');
    out.appendLine(`  • ${fmtDate(s.lastActivity)}  ${s.title || '(sans titre)'}  [${s.requests.length} req · ${models}]  tâche=${m.task ?? '-'}  projet=${m.root ?? detectFolder(s) ?? 'auto'}`);
  }
  if (dir && fs.existsSync(dir) && !reqs.length) out.appendLine('Aucune requête reconnue : le format des journaux a peut-être changé. Joignez un fichier de chatSessions (anonymisé) pour adapter le parseur.');
}

// ---------------------------------------------------------------- rapprochement

/** Dossiers de sessions de chat de TOUS les workspaces (+ fenêtres sans dossier). */
function allSessionDirs(): { label: string; dir: string; current: boolean }[] {
  const res: { label: string; dir: string; current: boolean }[] = [];
  if (!ctx.storageUri) return res;
  const wsStorage = path.dirname(path.dirname(ctx.storageUri.fsPath));
  const currentHash = path.basename(path.dirname(ctx.storageUri.fsPath));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(wsStorage);
  } catch {
    return res;
  }
  for (const h of entries) {
    const dir = path.join(wsStorage, h, 'chatSessions');
    if (!fs.existsSync(dir)) continue;
    let label = h;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(wsStorage, h, 'workspace.json'), 'utf8'));
      const u: string = j.folder ?? j.workspace ?? '';
      if (u) label = decodeURIComponent(u.replace(/^file:\/\/\/?/, '')).split(/[\\/]/).filter(Boolean).pop() ?? h;
    } catch {
      /* pas de workspace.json */
    }
    res.push({ label, dir, current: h === currentHash });
  }
  const empty = path.join(path.dirname(wsStorage), 'globalStorage', 'emptyWindowChatSessions');
  if (fs.existsSync(empty)) res.push({ label: '(fenêtres sans dossier)', dir: empty, current: false });
  return res;
}

async function reconcile(): Promise<void> {
  const now = new Date();
  const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const monthPick = await vscode.window.showInputBox({ prompt: 'Mois à rapprocher (AAAA-MM)', value: ym, validateInput: (v) => (/^\d{4}-\d{2}$/.test(v) ? undefined : 'Format AAAA-MM') });
  if (!monthPick) return;
  if (Date.now() - pricesLoadedAt > 60_000) await loadVscodePrices();
  const cpt = cfg().get<number>('charsPerToken', 4);
  const price = cfg().get<number>('creditPrice', 0.01);
  type Agg = { req: number; est: number; logged: number; inT: number; cache: number; write: number; outT: number; cr: number };
  const z = (): Agg => ({ req: 0, est: 0, logged: 0, inT: 0, cache: 0, write: 0, outT: 0, cr: 0 });
  const byModel = new Map<string, Agg>();
  const byDay = new Map<string, number>();
  const byWs = new Map<string, { cr: number; current: boolean }>();
  let total = z();

  for (const { label, dir, current } of allSessionDirs()) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.jsonl?$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        if (fs.statSync(file).mtimeMs < new Date(monthPick + '-01T00:00:00').getTime()) continue;
      } catch {
        continue;
      }
      let s: ParsedSession | undefined;
      try {
        s = parseSessionFile(file, cpt);
      } catch {
        continue;
      }
      for (const r of s?.requests ?? []) {
        const d = new Date(r.timestamp);
        if (`${d.getFullYear()}-${pad(d.getMonth() + 1)}` !== monthPick || !r.completed) continue;
        const k = costs(r);
        const add = (a: Agg) => {
          a.req++;
          if (!r.measured) a.est++;
          if (k.creditsLogged) a.logged++;
          a.inT += r.inputTokens;
          a.cache += r.cachedTokens;
          a.write += r.cacheWriteTokens;
          a.outT += r.outputTokens;
          a.cr += k.credits;
        };
        const m = byModel.get(r.model) ?? z();
        add(m);
        byModel.set(r.model, m);
        add(total);
        const day = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        byDay.set(day, (byDay.get(day) ?? 0) + k.credits);
        const w = byWs.get(label) ?? { cr: 0, current };
        w.cr += k.credits;
        byWs.set(label, w);
      }
    }
  }

  const n = (x: number, d = 2) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const i = (x: number) => x.toLocaleString('fr-FR');
  out.show(true);
  out.appendLine(`—— Rapprochement ${monthPick} (tous les workspaces de cette machine) ——`);
  out.appendLine('À comparer avec GitHub > Billing > Usage breakdown (par modèle) et le graphique journalier.');
  out.appendLine('');
  out.appendLine('Modèle | Requêtes | Tokens entrée | dont cache lu | dont cache écrit | Tokens sortie | Crédits | Montant');
  for (const [m, a] of [...byModel].sort((x, y) => y[1].cr - x[1].cr))
    out.appendLine(`${m} | ${a.req}${a.est ? ` (${a.est} estimées)` : ''} | ${i(a.inT)} | ${i(a.cache)} | ${i(a.write)} | ${i(a.outT)} | ${n(a.cr)} | ${n(a.cr * price)} $`);
  out.appendLine(`TOTAL | ${total.req} | ${i(total.inT)} | ${i(total.cache)} | ${i(total.write)} | ${i(total.outT)} | ${n(total.cr)} | ${n(total.cr * price)} $`);
  out.appendLine(`Crédits lus dans les journaux Copilot : ${total.logged}/${total.req} requête(s) ; les autres sont calculés depuis les tokens.`);
  out.appendLine('');
  out.appendLine('Par jour : ' + [...byDay].sort((a, b) => a[0].slice(3).localeCompare(b[0].slice(3)) || a[0].localeCompare(b[0])).map(([d, c]) => `${d} ${n(c)} cr`).join(' · '));
  out.appendLine('Par workspace : ' + [...byWs].sort((a, b) => b[1].cr - a[1].cr).map(([w, v]) => `${w}${v.current ? ' (actuel)' : ''} ${n(v.cr)} cr`).join(' · '));
  out.appendLine('');
  out.appendLine('Non visible ici : Copilot CLI, github.com, revue de code, agent cloud, autres machines/éditeurs, et les appels internes non journalisés (titres, résumés de contexte, sous-agents).');
}

async function showPrices(): Promise<void> {
  out.show(true);
  out.appendLine('—— Tarifs des modèles Copilot (crédits IA / 1M tokens) ——');
  await loadVscodePrices(true);
  const src = cfg().get<string>('priceSource', 'vscode');
  out.appendLine(
    Object.keys(vscodePrices).length
      ? `Source utilisée : ${src === 'vscode' ? 'VS Code (réglage modelPrices pour les modèles absents)' : 'réglage modelPrices uniquement'}. Valeur du crédit : ${cfg().get<number>('creditPrice', 0.01)} ${cfg().get<string>('currency', 'USD')}.`
      : 'Aucun tarif exposé par VS Code : le réglage modelPrices est utilisé.',
  );
}

async function offerRebuild(msg: string): Promise<void> {
  const a = await vscode.window.showInformationMessage(`${msg} Recalculer tout l’historique ?`, 'Recalculer', 'Plus tard');
  if (a === 'Recalculer') await rebuild(false);
}

async function menu(): Promise<void> {
  const items = [
    { label: '$(tag) Taguer une conversation', cmd: 'copilotCosts.tagSession' },
    { label: '$(save) Enregistrer les coûts maintenant', cmd: 'copilotCosts.flushNow' },
    { label: '$(table) Ouvrir le fichier de coûts', cmd: 'copilotCosts.openReport' },
    { label: '$(sync) Tout recalculer (maille, prix, historique)', cmd: 'copilotCosts.rebuild' },
    { label: '$(list-unordered) Afficher les tarifs des modèles', cmd: 'copilotCosts.importPrices' },
    { label: '$(checklist) Rapprochement avec la facture GitHub', cmd: 'copilotCosts.reconcile' },
    { label: '$(gear) Réglages', cmd: 'workbench.action.openSettings', arg: 'copilotCosts' },
    { label: '$(pulse) Diagnostic', cmd: 'copilotCosts.diagnostics' },
  ];
  const p = await vscode.window.showQuickPick(items, { placeHolder: 'Copilot Coûts' });
  if (p) await vscode.commands.executeCommand(p.cmd, ...(p.arg ? [p.arg] : []));
}

// ---------------------------------------------------------------- activation

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('Copilot Coûts');
  store = new CsvStore(cfg().get<string>('csvDelimiter', ';'));
  if (!ctx.globalState.get('installedAt')) void ctx.globalState.update('installedAt', Date.now());

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'copilotCosts.menu';
  status.text = '$(graph) …';
  status.show();

  context.subscriptions.push(
    out,
    status,
    vscode.commands.registerCommand('copilotCosts.tagSession', tagSession),
    vscode.commands.registerCommand('copilotCosts.flushNow', async () => {
      await flush('Manuel');
      void vscode.window.setStatusBarMessage(lastError ? `Copilot Coûts : ${lastError}` : `Copilot Coûts : ${lastWritten} ligne(s) ajoutée(s)`, 5000);
    }),
    vscode.commands.registerCommand('copilotCosts.openReport', openReport),
    vscode.commands.registerCommand('copilotCosts.diagnostics', diagnostics),
    vscode.commands.registerCommand('copilotCosts.menu', menu),
    vscode.commands.registerCommand('copilotCosts.rebuild', rebuildCommand),
    vscode.commands.registerCommand('copilotCosts.importPrices', showPrices),
    vscode.commands.registerCommand('copilotCosts.reconcile', reconcile),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('copilotCosts')) return;
      store.defaultDelim = cfg().get<string>('csvDelimiter', ';');
      sessionCache.clear();
      restartTimer();
      if (RECALC_KEYS.some((k) => e.affectsConfiguration(`copilotCosts.${k}`))) {
        // Plusieurs événements arrivent pendant l'édition des réglages : on attend qu'ils se calment.
        if (askTimer) clearTimeout(askTimer);
        askTimer = setTimeout(() => void offerRebuild('Réglages Copilot Coûts modifiés.'), 2000);
      } else void flush('Réglages modifiés');
    }),
    { dispose: () => timer && clearInterval(timer) },
  );

  if (!ctx.storageUri) {
    status.text = '$(graph) –';
    status.tooltip = 'Copilot Coûts : ouvrez un dossier ou un workspace.';
    return;
  }
  restartTimer();
  // Les modèles Copilot ne sont pas toujours prêts au démarrage : chargement des tarifs puis première écriture.
  setTimeout(() => void flush('Démarrage'), 8000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lm = (vscode as any).lm;
  if (lm?.onDidChangeChatModels) context.subscriptions.push(lm.onDidChangeChatModels(() => (pricesLoadedAt = 0)));
}

export async function deactivate(): Promise<void> {
  if (timer) clearInterval(timer);
  await flush('Fermeture');
}
