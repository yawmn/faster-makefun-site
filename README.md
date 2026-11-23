# faster-makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yawmn/faster-makefun-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yawmn/faster-makefun-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A drop-in replacement for makefun-site 1.0.0: `solve.js` returns the same output tree, byte for byte, for every case, using about 2.4× less CPU time on the practice set (2.42× over 22 interleaved runs against the vendored reference, Welch t = 43.5, one-sided p < 1e-9). Templates are parsed once and compiled into plain functions, Markdown is rendered in one pass with text escaped in whole runs, and build-constant or per-element partials are rendered once and reused.

Correctness is checked differentially against the reference on the practice set (3/3 cases identical), 28 hand-written adversarial cases, and 765+ randomly generated sites from the kit's own generator with zero mismatches; `answers.json` is deterministic across runs.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wkpcknk0&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
