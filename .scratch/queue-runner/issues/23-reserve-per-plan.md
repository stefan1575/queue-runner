# 23: A share kept for Stefan of Fable's week, and of ChatGPT's

**Blocked by:** None

**Status:** needs-triage

Pinned: 2026-11-15, Stefan ("would like a separate allocation for Fable as well, alongside
ChatGPT").

Today one share is kept for him: `reserve` percent of Claude's week (5 by default), until 24
hours before the week resets (AGENTS.md, The usage gate; `gate.json`, `--reserve N`). Nothing is
kept of Fable's own weekly window, which the runner doesn't use and only reports, nor of
ChatGPT's windows: Sol's reviews aren't gated at all.

What he wants: a share of his own for each, set apart. That means a reserve per window the
gate knows about (Claude's week, Fable's week, ChatGPT's session and week), and for ChatGPT it
means gating the Sol lane, which is new: today a review that runs out of usage is simply done
again after the reset.

To settle before building: whether a reserve on a window the runner doesn't spend (Fable's) is
only shown, or should also hold the runner back from a model it may use later; and whether
ChatGPT's reserve stops a review from starting or only warns.

The dashboard's Settings page already has the row for it ("Your share of each plan": Claude's
is live, ChatGPT's says "Not built yet").

## Comments
