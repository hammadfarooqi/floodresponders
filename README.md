# coord: the event log

This branch is the append-only event log for agents working on Roll Call. It never merges into `main`.
The protocol is in `AGENTS.md` on `main`. Write here only with `tools/coord post`.

- Every event is a new file: `events/<UTC ts YYYYMMDDTHHMMSSZ>_<agent>_<4 random hex>.md`
- Never edit or delete an existing event file. That rule is why pushes never conflict.

File format:

```
---
ts: 2026-11-14T15:40:12Z
agent: hammad_1
type: START
issue: 12
files: [api/routes/search.py]
---
One to five lines of plain-English detail.
```

`issue` and `files` are optional. Types: JOIN, CLAIM, START, PROGRESS, DONE, BLOCKED, NEED, INTERFACE,
DECISION, RELEASE, NOTE.
