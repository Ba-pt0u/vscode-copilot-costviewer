import * as fs from 'fs';
import * as path from 'path';

export const HEADER = [
  'Date', 'Heure', 'Mois', 'Utilisateur', 'Workspace', 'Projet', 'Chemin projet', 'Tâche', 'Conversation',
  'ID session', 'ID requête', 'Modèle', 'Multiplicateur', 'Tokens entrée', 'Tokens cache', 'Tokens écriture cache', 'Tokens sortie',
  'Tokens total', 'Source tokens', 'Crédits', 'Source crédits', 'Requêtes premium', 'Coût tokens', 'Coût requêtes premium', 'Coût', 'Devise',
];

export interface CsvRow {
  key: string; // sessionId|requestId
  rec: Record<string, string>; // valeurs par nom de colonne
}

const BOM = '﻿';

export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function esc(v: string, delim: string): string {
  return /["\r\n]/.test(v) || v.includes(delim) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Clé de tri chronologique d'une ligne : « AAAA-MM-JJ HH:MM:SS » (tri lexical = tri chronologique). */
const stampOf = (get: (col: string) => string | undefined) => `${get('Date') ?? ''} ${get('Heure') ?? ''}`;

function sortRows(header: string[], rows: string[][]): string[][] {
  const d = header.indexOf('Date');
  const h = header.indexOf('Heure');
  if (d < 0) return rows;
  const key = (r: string[]) => `${r[d] ?? ''} ${h >= 0 ? r[h] ?? '' : ''}`;
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.r);
}

function detectDelim(headerLine: string, fallback: string): string {
  for (const d of [';', '\t', ',']) if (headerLine.includes(d)) return d;
  return fallback;
}

interface FileInfo {
  mtime: number;
  size: number;
  delim: string;
  header: string[];
  keys: Set<string>;
  lastStamp: string; // date/heure la plus récente du fichier
}

export class CsvStore {
  private cache = new Map<string, FileInfo>();
  constructor(public defaultDelim: string) {}

  private read(file: string): { info: FileInfo; rows: string[][] } | undefined {
    if (!fs.existsSync(file)) return undefined;
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const delim = detectDelim(text.split(/\r?\n/, 1)[0] ?? '', this.defaultDelim);
    const rows = parseCsv(text, delim);
    const header = rows[0] ?? [];
    const s = header.indexOf('ID session');
    const r = header.indexOf('ID requête');
    const keys = new Set<string>();
    if (s >= 0 && r >= 0) for (const row of rows.slice(1)) if (row[r]) keys.add(row[s] + '|' + row[r]);
    let lastStamp = '';
    for (const row of rows.slice(1)) {
      const k = stampOf((c) => row[header.indexOf(c)]);
      if (k > lastStamp) lastStamp = k;
    }
    const info = { mtime: st.mtimeMs, size: st.size, delim, header, keys, lastStamp };
    this.cache.set(file, info);
    return { info, rows };
  }

  private info(file: string): FileInfo | undefined {
    if (!fs.existsSync(file)) return undefined;
    const st = fs.statSync(file);
    const c = this.cache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
    return this.read(file)?.info;
  }

  /** Ajoute les lignes absentes du fichier. Retourne le nombre de lignes écrites. */
  append(file: string, rows: CsvRow[]): number {
    const info = this.info(file);
    const delim = info?.delim ?? this.defaultDelim;
    const seen = new Set(info?.keys ?? []);
    const fresh = rows.filter((r) => !seen.has(r.key) && (seen.add(r.key), true));
    if (!fresh.length) return 0;
    fresh.sort((a, b) => {
      const x = stampOf((c) => a.rec[c]);
      const y = stampOf((c) => b.rec[c]);
      return x < y ? -1 : x > y ? 1 : 0;
    });

    // Lignes plus anciennes que la fin du fichier : on réécrit le fichier entier, trié.
    if (info && stampOf((c) => fresh[0].rec[c]) < info.lastStamp) {
      this.rewrite(file, (header, existing) => [...existing, ...fresh.map((r) => header.map((h) => r.rec[h] ?? ''))]);
      return fresh.length;
    }

    let chunk = '';
    if (!info) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      chunk += BOM + HEADER.map((h) => esc(h, delim)).join(delim) + '\r\n';
    } else if (info.size > 0) {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, info.size - 1);
      fs.closeSync(fd);
      if (b[0] !== 0x0a) chunk += '\r\n';
    }
    // Les valeurs suivent l'en-tête du fichier existant (ancienne version : colonnes manquantes ignorées).
    const header = info?.header.length ? info.header : HEADER;
    chunk += fresh.map((r) => header.map((h) => esc(r.rec[h] ?? '', delim)).join(delim)).join('\r\n') + '\r\n';
    fs.appendFileSync(file, chunk, 'utf8');
    this.cache.delete(file);
    return fresh.length;
  }

  /** Vrai si le fichier existe et ne peut pas être ouvert en écriture (ouvert dans Excel). */
  isLocked(file: string): boolean {
    if (!fs.existsSync(file)) return false;
    try {
      fs.closeSync(fs.openSync(file, 'r+'));
      return false;
    } catch (e) {
      return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
    }
  }

  /**
   * Réécrit le fichier : `transform` reçoit l'en-tête et les lignes de données et renvoie
   * les lignes à garder. Sans ligne restante, le fichier est supprimé.
   */
  rewrite(
    file: string,
    transform: (header: string[], rows: string[][]) => string[][],
    backup = false,
    upgradeHeader = false,
  ): { before: number; after: number; deleted: boolean } {
    const data = this.read(file);
    if (!data) return { before: 0, after: 0, deleted: false };
    let [header = [], ...rows] = data.rows;
    if (upgradeHeader && header.join('\u0001') !== HEADER.join('\u0001')) {
      const old = header;
      rows = rows.map((r) => HEADER.map((h) => (old.indexOf(h) >= 0 ? r[old.indexOf(h)] ?? '' : '')));
      header = HEADER;
    }
    const kept = sortRows(header, transform(header, rows));
    if (backup) fs.copyFileSync(file, file + '.bak');
    this.cache.delete(file);
    if (!kept.length) {
      fs.unlinkSync(file);
      return { before: rows.length, after: 0, deleted: true };
    }
    const d = data.info.delim;
    const text = BOM + [header, ...kept].map((r) => r.map((v) => esc(v ?? '', d)).join(d)).join('\r\n') + '\r\n';
    fs.writeFileSync(file, text, 'utf8');
    return { before: rows.length, after: kept.length, deleted: false };
  }

  /** Supprime les lignes d'une conversation (utilisé quand on la retague). */
  removeSession(file: string, sessionId: string): number {
    let removed = 0;
    this.rewrite(file, (header, rows) => {
      const s = header.indexOf('ID session');
      const kept = s < 0 ? rows : rows.filter((r) => r[s] !== sessionId);
      removed = rows.length - kept.length;
      return kept;
    });
    return removed;
  }
}
