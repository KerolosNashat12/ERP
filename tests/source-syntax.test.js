/**
 * Every source file parses — and the reason this exists is embarrassing.
 *
 * Three separate rounds of this project have been lost to the SAME mistake: a
 * backtick inside a comment inside a SQL template literal. It is invisible in
 * review (a comment about `settlement` is exactly how anybody would write it),
 * it is a SyntaxError at IMPORT time rather than at the line, and the error it
 * produces — "missing ) after argument list", "Unexpected identifier" — points
 * nowhere near the backtick. Twice it reached a package.
 *
 * `node --check` on every file catches all of it in under a second, so there is
 * no reason for a fourth round. This is not a style rule and it is not linting:
 * it is the cheapest possible answer to a defect that has actually shipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js under a directory, skipping the places that are not ours. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('every source and browser file parses', () => {
  const files = [
    ...walk(path.join(root, 'src')),
    ...walk(path.join(root, 'public')),
    ...walk(path.join(root, 'scripts')),
  ];
  assert.ok(files.length > 100, `only ${files.length} files found — this is not scanning the project`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      const message = String(error.stderr || error.message).split('\n').slice(0, 4).join(' ').trim();
      broken.push(`${path.relative(root, file)} — ${message}`);
    }
  }
  assert.deepEqual(broken, [], `these files do not parse:\n${broken.join('\n')}`);
});

/*
 * THE NARROWER TEST THAT IS NOT HERE, and why.
 *
 * The obvious companion to the one above is "no backtick inside a SQL template
 * literal", named after the actual mistake so a failure reads as an instruction
 * rather than as a parser error. It was written, and then deleted, because a
 * regex cannot tell the difference between the mistake and this, which is
 * correct and lives in BaseRepository:
 *
 *   .prepare(`SELECT COUNT(*) FROM ${this.table} ${where ? `WHERE ${where}` : ''}`)
 *
 * A non-greedy match stops at the nested literal's own backtick and reports a
 * file that is perfectly fine. Doing it properly needs a JavaScript parser, and
 * a test that cries wolf on correct code is a test somebody switches off — at
 * which point it protects nothing.
 *
 * `node --check` above catches the real failure mode anyway: an UNBALANCED
 * backtick, which is what a comment introduces every time, and which is what
 * has actually cost this project three rounds. The narrow version would only
 * add the case where two stray backticks happen to balance each other and
 * silently truncate the SQL — rarer than the false positives it would produce.
 */
