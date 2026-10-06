import type { ParsedRequest } from './parser';

/** Tarif en crédits IA par million de tokens. */
export interface PriceEntry {
  input: number;
  output: number;
  cached?: number; // lecture de cache
  cacheWrite?: number; // écriture de cache
  longInput?: number; // tarifs « long context » (au-delà de longContextThreshold tokens d'entrée)
  longOutput?: number;
  longCached?: number;
  longCacheWrite?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-/]/g, '');

/** Clé la plus longue contenue dans le nom du modèle, sinon « * ». */
export function findKey<T>(model: string, table: Record<string, T>): string | undefined {
  const m = norm(model);
  let best: string | undefined;
  for (const key of Object.keys(table ?? {})) {
    if (key === '*') continue;
    const k = norm(key);
    if (k && m.includes(k) && (!best || k.length > norm(best).length)) best = key;
  }
  if (best) return best;
  return table && '*' in table ? '*' : undefined;
}

/**
 * Crédits d'une requête. Hypothèse (format OpenAI, utilisé par Copilot) : les tokens d'entrée
 * incluent les tokens lus et écrits en cache ; seule la part restante est facturée au tarif « input ».
 */
export function tokenCost(r: ParsedRequest, table: Record<string, PriceEntry>, longThreshold = Infinity): number {
  const key = findKey(r.model, table);
  const p = key ? table[key] : undefined;
  if (!p) return 0;
  const long = r.inputTokens > longThreshold && p.longInput !== undefined;
  const pin = long ? p.longInput! : p.input ?? 0;
  const pout = long ? p.longOutput ?? p.output ?? 0 : p.output ?? 0;
  const pcached = long ? p.longCached ?? p.cached ?? pin : p.cached ?? pin;
  const pwrite = long ? p.longCacheWrite || p.cacheWrite || pin : p.cacheWrite || pin;
  const cached = Math.min(r.cachedTokens, r.inputTokens);
  const write = Math.min(r.cacheWriteTokens ?? 0, r.inputTokens - cached);
  const fresh = Math.max(0, r.inputTokens - cached - write);
  return (fresh * pin + cached * pcached + write * pwrite + r.outputTokens * pout) / 1e6;
}

export function multiplierFor(r: ParsedRequest, table: Record<string, number>): number {
  if (r.multiplier !== undefined) return r.multiplier;
  const key = findKey(r.model, table);
  return key && typeof table[key] === 'number' ? table[key] : 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const num = (v: any): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Lit le tarif exposé par un modèle de vscode.lm (inputCost, outputCost, cacheCost…). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function priceFromModel(m: any): PriceEntry | undefined {
  const input = num(m?.inputCost);
  const output = num(m?.outputCost);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cached: num(m.cacheCost),
    cacheWrite: num(m.cacheWriteCost),
    longInput: num(m.longContextInputCost),
    longOutput: num(m.longContextOutputCost),
    longCached: num(m.longContextCacheCost),
    longCacheWrite: num(m.longContextCacheWriteCost),
  };
}
