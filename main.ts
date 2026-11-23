// The harness runs `node /bot/main.ts` on Node 22: it reads every case from /input/cases.json, answers each one alone
// with run() from solve.js, and writes /output/answers.json, one answer per case in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Each case's answer is serialized and written before the next case runs, so only one case's output tree is ever
// held in memory: the same bytes as JSON.stringify(answers), with far less garbage to collect.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';


import { run } from './solve.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  writeSync(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    const text = JSON.stringify(run(cases[i]!.input));
    writeSync(fd, i === 0 ? text : `,${text}`);
  }
  writeSync(fd, ']');
} finally {
  closeSync(fd);
}
