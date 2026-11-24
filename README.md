# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alenoathera/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alenoathera/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for make.fun — referral code `grdyyq5p`.

`mend` is a command-line patch tool that applies edits written by AI models to a tree of text files. Models write edits in four formats:
- Unified diffs (often with drifted line numbers)
- SEARCH/REPLACE blocks
- V4A patches
- Text-editor tool calls as JSON

`mend` reads the patch in any of these formats (or auto-detects it) and applies changes atomically: either all files are updated, or none are.

`SPEC.md` serves as the complete specification and contract.

## The files

- `main.ts`: The complete CLI implementation (Node 22, standard library alone). Run it as `node main.ts [options] [PATCH]`.
- `runner.ts`: Grader harness for trials; executes checks in fresh directories and reports exit codes, standard output, and changed files.
- `README.md`: This file.
- `LICENSE`: MIT License.

## Running checks

To run the practice checks locally:

```bash
node check.ts path/to/practice.json
```

Or run specific check families:

```bash
node check.ts path/to/practice.json u-offset s-basic
```
