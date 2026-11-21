[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/rizalarkana77/csv-reader-speed-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/rizalarkana77/csv-reader-speed-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# Slice CSV — a faster drop-in for csv-reader 1.0.0

`csv-reader-speed-01-run-20261121` — "Read broken CSV files faster, 21 November 2026".

A dependency-free ES module that answers exactly as make.fun's own csv-reader
1.0.0 does on every case — same `{columns, rows, errors}`, same broken-row
policy (stray CRs, quote junk, unterminated quotes, short/long rows, BOM,
CRLF, multi-line quoted fields) — but about **4x faster on CPU time** than
the reference on the practice set (~0.26 s vs ~1.10 s for 6 cases, 10.2 MB
of CSV).

## How it works

First principles: the reference spends its time stepping one character at a
time and growing every field one character at a time. Most of a file is plain
text — unquoted fields, commas, line breaks — so this parser finds each
field's end with `indexOf` (V8's memchr-fast scan) and cuts it out with one
`slice`. Only the rare broken bits (quotes, stray CRs) take the careful path.

- **Clean-line fast path:** a line with no quote and no stray CR is one
  `split(',')` for the whole record.
- **Slow path, field by field:** unquoted fields end at the first comma or
  line break found by `indexOf`; quoted fields find their closing quote the
  same way, skipping doubled quotes, and only transform the value when the
  content actually holds a CR or a doubled quote.
- **Bounded searches:** every `indexOf` stays inside the field or line it
  belongs to — a search is never allowed to run past the delimiter it is
  looking for. (An unbounded search for a rare CR or quote is what makes a
  naive `indexOf` parser slow.)

## Verification

- Practice set: **6/6 cases identical** to the oracle, and identical to the
  baseline's own answers.
- 30 further cases drawn from the published generator with fresh seeds:
  **30/30 identical**.
- 158 hand-built edge cases (empty text, BOM-only, lone CRs, unterminated
  quotes, quote junk with stray CRs, multi-line quoted fields, short/long
  rows, no trailing newline): **158/158 identical** to csv-reader 1.0.0.

## Files

- `solve.js` — the parser: `run(input)` returns csv-reader's answer for
  `{text, header}`.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
