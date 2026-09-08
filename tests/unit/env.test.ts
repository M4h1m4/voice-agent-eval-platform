import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../lib/config/env.js';

const withFile = (body: string, fn: (p: string) => void) => {
  const d = mkdtempSync(join(tmpdir(), 'env-'));
  const p = join(d, '.env');
  writeFileSync(p, body, 'utf8');
  try { fn(p); } finally { rmSync(d, { recursive: true }); }
};

test('values are read, quotes stripped, comments and blanks ignored', () => {
  withFile('# a comment\n\nA_KEY=plain\nB_KEY="quoted"\nC_KEY=\n', (p) => {
    delete process.env.A_KEY; delete process.env.B_KEY; delete process.env.C_KEY;
    loadEnv(p);
    assert.equal(process.env.A_KEY, 'plain');
    assert.equal(process.env.B_KEY, 'quoted');
    assert.equal(process.env.C_KEY, undefined, 'an empty value must not shadow a real one');
    delete process.env.A_KEY; delete process.env.B_KEY;
  });
});

test('an existing variable wins — a stale file must not override the command line', () => {
  // LLM_MODE=live typed at the prompt has to beat LLM_MODE=replay in the file, and
  // the reverse must also hold, or a forgotten file could quietly spend money.
  withFile('OVERRIDE_ME=from_file\n', (p) => {
    process.env.OVERRIDE_ME = 'from_shell';
    loadEnv(p);
    assert.equal(process.env.OVERRIDE_ME, 'from_shell');
    delete process.env.OVERRIDE_ME;
  });
});

test('a value containing = survives intact', () => {
  withFile('TOKEN=abc=def==\n', (p) => {
    delete process.env.TOKEN;
    loadEnv(p);
    assert.equal(process.env.TOKEN, 'abc=def==');
    delete process.env.TOKEN;
  });
});

test('a missing file is not an error', () => {
  assert.doesNotThrow(() => loadEnv(join(tmpdir(), 'definitely-absent-8813')));
});
