// restart-ineffective.test.mjs — the .mjs OOP classifier's half of the anti-divergence
// guarantee. Loads the SAME LOCKED golden vector the Python oracle and the daemon .ts unit
// test load (restart-ineffective-golden.json) and asserts classifyRestartIneffective()
// reproduces every expected verdict. If this and the daemon .ts test both pass the same JSON,
// the two independent implementations cannot silently diverge.
//   Run: node scripts/self-healing/tests/restart-ineffective.test.mjs   (exit 0 = all pass)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { classifyRestartIneffective } from '../restart-ineffective-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(readFileSync(join(HERE, 'restart-ineffective-golden.json'), 'utf8'));
const { N, scan_window_ms: win, cases } = vec;

let failures = 0;
for (const c of cases) {
  const got = classifyRestartIneffective(c, N, win);
  const exp = c.expected;
  const ok =
    got.ineffective === exp.ineffective &&
    got.streak === exp.streak &&
    got.newestSessionId === exp.newestSessionId &&
    got.label === exp.label;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  if (!ok) {
    failures += 1;
    console.log(`   expected: ${JSON.stringify(exp)}`);
    console.log(`   got:      ${JSON.stringify(got)}`);
  }
}
console.log(`--- ${cases.length - failures}/${cases.length} cases pass ---`);
process.exit(failures ? 1 : 0);
