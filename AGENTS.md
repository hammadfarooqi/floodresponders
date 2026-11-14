# AGENTS.md: how agents work together on Roll Call

Several coding agents work on this repo at the same time. Every agent must follow this file exactly.
Humans: Hammad, Selina, Jackson, Rasul. Agent names are `<firstname>_<number>`, for example `rasul_1`.

**Project:** Roll Call helps responders in fires and floods. It finds the buildings where people are most
likely to be trapped, assigns each building to a nearby responder, and has an AI agent call the building
manager to ask who needs help. Details and shared interfaces are in `CONTRACTS.md`.

**Deadline:** TBD (a human will fill this in). Near the deadline, finish and merge work. Do not start new work.

## Setup, once per machine and once per agent

```
git clone https://github.com/hammadfarooqi/floodresponders.git && cd floodresponders
tools/coord init
tools/coord new-agent <name>      # once for each agent you run, then use the cd and export lines it prints
```

`tools/coord` needs `git` and `gh` (logged in). It uses `flock` when installed and its own lock when not.
You do not need to install anything else. Inside a worktree, call it as `tools/coord`. This file writes
`coord` for short.

## The three channels

1. **GitHub Issues: the task board.** One issue per unit of work, about 30 to 90 minutes each. You claim an
   issue with `coord claim N`. Humans watch and steer from the web UI.
2. **`coord` branch: the append-only event log.** Who started what, what finished, interface changes,
   blockers, discoveries. It is an orphan branch and never merges into `main`. Every event is a new file
   under `events/`. Nobody edits an existing event file, so pushes never conflict. Write to it only with
   `coord post`.
3. **`main`: the code.** Work on a short-lived branch `agent/<agent>/<issue#>-<slug>`, open a PR with
   `Closes #N`, and merge when checks pass. A branch lives for minutes to an hour, never days.

Event types: `JOIN`, `CLAIM`, `START`, `PROGRESS`, `DONE`, `BLOCKED`, `NEED` (you ask another agent or a
human for something), `INTERFACE` (you changed a shared contract), `DECISION` (architecture or product
choice), `RELEASE` (you drop a claim), `NOTE`.

Event messages are short and factual, one to five lines. Write them for an agent that reads 40 events at once.

## The loop

1. `git pull` on main; `coord tail 40`; `coord active`; `coord board`.
2. If you hold an active claim, continue it. Otherwise pick the highest-priority `status:ready` issue in or near your area that nobody is holding, then `coord claim N`. If you LOST, go back to step 1.
3. `coord post START --issue N --files <what you'll touch>`. Branch: `agent/$AGENT_NAME/N-slug`.
4. Work in small commits. **About every 15 minutes, or at any milestone:** run `coord since <last-check>`, react to `INTERFACE`, `NEED`, and `DECISION` events that affect you, then post `PROGRESS` (this doubles as your heartbeat).
5. Before opening the PR: rebase on main, run the checks, and if you touched a shared interface, update CONTRACTS.md and post `INTERFACE`.
6. `gh pr create --fill --body "Closes #N"`, then `gh pr checks --watch --fail-fast && gh pr merge --squash --delete-branch`. Once it's merged, `coord done N "<one-line result>"`.
7. If you discovered follow-up work, create issues (`gh issue create`, labeled `status:ready` plus an area label), then `coord post NOTE`. If you're blocked for more than 10 min, post `BLOCKED` or `NEED` and switch to another issue.
8. Go to step 1. Never sit idle. If the board is empty, post `NOTE` and write issues for testing, polish, or demo prep.

Note on step 6: this repo has no branch protection, so `gh pr merge --auto` would merge at once without
waiting for CI. Always wait for green checks first, as the command in step 6 does. Merge only on green.

If every CI job fails in a few seconds with "account is locked due to a billing issue", GitHub Actions is
down for this repo (see issue #27) and no code is at fault. In that case only: run the checks from the
Checks section on your machine, write the result in the PR, then `gh pr merge --squash --delete-branch`.

## Work areas

| Area label | Paths | What is there |
|---|---|---|
| `area:web` | `web/` | Next.js + TypeScript app: map, scenario controls, queue, call view |
| `area:api` | `api/` | FastAPI app: buildings, hazard and risk score, priority queue, call endpoints |
| `area:agent` | `agent/` | Calling agent built with LangChain Deep Agents |
| `area:data` | `data/` | Sample city, responders, sponsor-data and public-feed adapters |
| `area:infra` | `tools/`, `.github/`, root docs | Coordination tool, CI, README, demo script |

This map is a first proposal. Change it with a `DECISION` event and a PR to this file.

## Ownership rules

- Touch files outside your claimed issue's area only after you post an `INTERFACE` or `NEED` event.
- If `coord active` shows another agent on files you need, do not edit them. Post a `NEED` to that agent or
  pick other work.
- Never rewrite, delete, or force-push someone else's work.
- Never edit an existing file under `events/`.
- Do not pick up issues labeled `human-decision`. A human decides and comments. If you need a product or
  architecture choice that affects others, add `human-decision` to an issue, post a `NEED` to the humans,
  and work on something else.

## Claim race rule

After you claim, `coord claim` checks the log. If another `CLAIM` for the same issue has an earlier `ts`,
the earlier one wins. It prints WON or LOST. If you LOST, post `RELEASE` and pick something else.

## Stale claims

A claim is stale when its owner has posted no event for 45 minutes. `coord active` marks it `STALE`. Anyone
may post `NOTE "taking over stale #N"`, claim the issue, and continue.

## Contracts

Shared types, API shapes, env vars, and DB schema live in `CONTRACTS.md`. To change one, your PR must
update `CONTRACTS.md`, and you must post an `INTERFACE` event that names who is affected.

## One worktree per agent

If more than one agent runs on a machine, each gets its own git worktree (`tools/coord new-agent <name>`).
Two agents must never share a working directory. They would overwrite each other's uncommitted changes,
branch checkouts, and build output.

- Create issue branches with `git switch -c agent/$AGENT_NAME/N-slug origin/main`.
- Use ports unique to your agent. With X as the number in your agent name: web `PORT=$((3000 + X))`,
  API `API_PORT=$((8000 + X))`.
- Never `cd` into or edit another worktree. Never run `git worktree remove` or `git clean` on a worktree
  that is not yours.
- When you stop for good, remove your own worktree with `git worktree remove`.

All agents on one machine share one log checkout at `<main clone>/.coord`. Do not edit it by hand.

## Commits and PRs

- Small commits with a plain message that says what changed, for example `api: add GET /api/buildings`.
- One issue per PR. The PR body has `Closes #N`. Squash merge.
- Rebase on `origin/main` before you open the PR. Never force-push to `main` or `coord`.
- Your `DONE` message says exactly how to use the result, for example
  `GET /api/buildings returns {buildings:[...]}`. Other agents learn about your work from that message.

## Checks

Run the checks for the areas you touched before you open a PR. CI runs the same ones.

| Area | Commands |
|---|---|
| tools | `bash -n tools/coord && tools/coord_smoke.sh` |
| `web/` | `cd web && npm ci && npm run lint && npm test --if-present && npm run build` |
| `api/` | `cd api && pip install -r requirements.txt && ruff check . && pytest` |
| `agent/` | `cd agent && pip install -r requirements.txt && ruff check . && pytest` |

**Keep `main` green.** If you break it, fixing it is your top priority.
