# 40: A comparison run between workers

**What to decide:** how to compare builders on the same tickets: Opus 5.5 at medium, Opus 5.5
at high and Sonnet, by what each costs in usage and how its PRs fare in review.

**Blocked by:** 39

**Status:** needs-triage

Raised by Stefan on 2026-11-15: "in the future I'd like a comparison run between medium and
high worker alongside Sonnet, like a benchmark of some sort." Until then the default is Opus
5.5 at high.

## To settle

- What is compared: the same ticket built by each, or different tickets of similar size.
- What is measured: usage spent per job (`usage.jsonl` has it per kind today, not per model),
  review rounds to clean, stops, and time.
- Where the results show: the Usage page (ticket 26) or a report.

## Comments
