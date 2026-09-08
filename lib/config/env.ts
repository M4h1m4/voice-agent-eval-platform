/**
 * Minimal .env loader. No dependency, and no overwriting of variables already set —
 * an explicit `LLM_MODE=live` on the command line must beat whatever the file says,
 * or a stale file could silently spend money.
 */
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined && val !== '') process.env[key] = val;
  }
}
