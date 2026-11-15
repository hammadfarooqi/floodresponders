# AGENTS.md: how agents work together on Roll Call

Several coding agents work on this repo at the same time. Every agent must follow this file exactly.
Humans: Hammad, Selina, Jackson, Rasul. Agent names are `<firstname>_<number>`, for example `rasul_1`.

**Project:** Roll Call helps responders in fires and floods. It finds the buildings where people are most
likely to be trapped, assigns each building to a nearby responder, and has an AI agent call the building
manager to ask who needs help. Details and shared interfaces are in `CONTRACTS.md`.

**Deadline:** TBD (a human will fill this in). Near the deadline, finish and merge work. Do not start new work.

## Setup, once per computer (a human does this)

```
git clone https://github.com/hammadfarooqi/floodresponders.git && cd floodresponders
tools/coord init <your first name>      # hammad, selina, jackson, or rasul
```

`tools/coord` needs `git` and `gh` (logged in). Nothing else to install.

To start an agent, open it in the `floodresponders` folder (terminal, desktop app, or IDE) and tell it:
`Start. Focus: <an area, or "anything">`. Do this again for each agent you want. Each agent names itself.

## Startup (every new agent does this first)

1. If your current folder is already named `floodresponders-<name>`, then `<name>` is your agent name and
   that folder is yours. Skip to step 3.
2. Run `tools/coord new-agent`. It gives you the next free name (`<firstname>_<number>`), makes your own
   folder next to the main one, and posts your `JOIN` event. Read its output.
   Only if your human told you to share a folder with other agents, run `tools/coord new-agent --here`
   instead and follow "Shared folder mode" below.
3. Work only in your own folder. Start every shell command with `cd <your folder> &&`, and edit files only
   by their path inside that folder. `coord` reads your name from that folder.
4. Read `AGENTS.md` and `CONTRACTS.md` in full, from your own folder.
5. Run `coord tail 60`, `coord active`, and `coord board` to see who does what.
6. Post `coord post NOTE "<your focus area>, starting"`. Then run the loop until your human tells you to
   stop. Your human's instructions override the backlog.

In this file, `coord` is short for `tools/coord`. So `coord tail 60` means you run
`cd <your folder> && tools/coord tail 60`.

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

1. `git fetch origin main` (your folder is not on `main`; every issue branch starts from `origin/main`); `coord tail 40`; `coord active`; `coord board`.
2. If you hold an active claim, continue it. Otherwise pick the highest-priority `status:ready` issue in or near your area that nobody is holding, then `coord claim N`. If you LOST, go back to step 1.
3. `coord post START --issue N --files <what you'll touch>`. Branch: `agent/<your name>/N-slug`.
4. Work in small commits. **About every 15 minutes, or at any milestone:** run `coord since <last-check>`, react to `INTERFACE`, `NEED`, and `DECISION` events that affect you, then post `PROGRESS` (this doubles as your heartbeat).
5. Before opening the PR: rebase on main, run the checks, and if you touched a shared interface, update CONTRACTS.md and post `INTERFACE`.
6. `gh pr create --fill --body "Closes #N"`, then `gh pr checks --watch --fail-fast && gh pr merge --squash --delete-branch`. Once it's merged, `coord done N "<one-line result>"`.
7. If you discovered follow-up work, create issues (`gh issue create`, labeled `status:ready` plus an area label), then `coord post NOTE`. If you're blocked for more than 10 min, post `BLOCKED` or `NEED` and switch to another issue.
8. Go to step 1. Never sit idle. If the board is empty, post `NOTE` and write issues for testing, polish, or demo prep.

**Keep the shared docs current.** `AGENTS.md`, `CONTRACTS.md` and `DATABASE.md` change during the day. In step 1,
in step 4, and before you answer your human about how something works, run:

```
git fetch origin main && git log --oneline <last commit you checked>..origin/main -- AGENTS.md CONTRACTS.md DATABASE.md
```

If it prints a commit, read the changed file again from `origin/main` (`git show origin/main:<file>`) before you
continue, and follow the new version. Remember the commit you checked (`git rev-parse origin/main`) for next time.
An agent only runs when it has a turn, so a human who wants this checked without asking can start the agent with
`/loop` (it then repeats the loop by itself).

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

## Database

The building data is in Supabase. Read `DATABASE.md` before you read from or write to it.

**Rule:** when you find a problem, a surprise or a limit in the database or in the data inside it, add it to
`DATABASE.md` under "Known problems", in the same PR as your work. Never put sponsor data in that file.

**Two scores exist. Use the right one** (added 2026-11-14, decided by Rasul):

- `risk_score` is stored in `buildings`. It uses building data only and does not know where a fire is.
- `fire_risk_score` is computed for one fire origin: `risk_score` x `fire_factor`, where `fire_factor` is 2 at
  the origin and goes down toward 1 with distance. Get it from the database function
  `buildings_fire_risk(p_origin_lat, p_origin_lng, p_wind_from_deg)` or from `data/db/fire_risk.py`.
- When your code has a fire origin and ranks or colors buildings from the database, use `fire_risk_score`.
  Do not write a second rule for "near the fire", and do not copy the weights: they are in `WEIGHTS` in
  `data/db/fire_risk.py` only.
- The origin comes from a person: the `/risk` page of `explore/` has a "Create fire origin" button. The demo run
  on `/sim` and `/console` keeps its fixed fire and `fire_arrival_min`; this score does not replace them.
- Rule, weights and limits: `DATABASE.md`, "How the score changes for a fire origin" and problems 56 to 58.

## One folder per agent (the default)

Each agent works in its own folder (a git worktree) that `tools/coord new-agent` makes. Two agents in one
folder can overwrite each other's uncommitted changes, branch checkouts, and build output.

- Create issue branches with `git switch -c agent/<your name>/N-slug origin/main`.
- Use ports unique to your agent. With X as the number in your agent name: web `PORT=$((3000 + X))`,
  API `API_PORT=$((8000 + X))`.
- Never `cd` into or edit another agent's folder. Never run `git worktree remove` or `git clean` on a
  folder that is not yours.
- When you stop for good, remove your own folder with `git worktree remove`.

All agents on one computer share one log checkout at `<main clone>/.coord`. Do not edit it by hand.

## Shared folder mode (only when a human asks for it)

A human may want two or more agents on one branch in one folder, each on a different part of the code.
An agent uses this mode only when its human says so. Rules for every agent in the shared folder:

- Get your name with `tools/coord new-agent --here`. Put it in front of every coord command:
  `AGENT_NAME=<your name> tools/coord <command>`. The folder cannot tell `coord` who you are.
- Stay on the branch that is checked out. Do not run `git switch`, `git checkout`, `git stash`,
  `git reset`, `git rebase`, `git pull`, or `git clean`. They change files under the other agents.
- Commit only your own files: `git add <your paths>`, then `git commit`. Never `git add -A` or
  `git commit -a`.
- Claims still apply. List your files in your `START` event, and never edit a file that another agent
  listed.
- The human, or the one agent the human names, pushes the branch and opens the PR.
- Use ports unique to your agent, as above.

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
