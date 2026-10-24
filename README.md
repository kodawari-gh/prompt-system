# prompt-system

A small dashboard and runner that works a project's TODO list one **fresh Claude session per task**, so context never piles up between tasks. Generic: point it at any git repo that has a TODO file in the format below.

```
node server.js        # then open http://localhost:4173   (PORT=... to change)
```

Needs Node 18+, the `claude` CLI (or the VS Code extension's bundled binary, auto-detected) and Git Bash on Windows. No npm dependencies.

## What you get

| View | Shows |
|---|---|
| Overview | open/done/blocked counts, spend, recent commits and runs, dirty-tree warning |
| Tasks | the TODO list with filters, expandable details, select `[auto]` tasks and run them with limits |
| Live | the running agent: current task, turns, context size against the compaction threshold, last actions, runner output, Stop |
| Costs | spend by model, per-run table, trend |
| Update prompt | the prompt that has Claude tick finished work and add split tasks; add notes and copy |

Add repos with **Add repo**; each has its own TODO path, test and build commands (Settings). Logs and `costs.tsv` live in `data/<project>/` here, not in your repo.

## TODO format (the contract)

`- [ ] T<nn> [auto|human|owner] {haiku|sonnet|opus} Title. Files: ... Docs: ... Test pattern: ... Done when: ...`

Plus a `## Rules for every task` section, which is put into every task prompt. `templates/TODO.template.md` has a starter ("Create from template" in the dashboard).

- Only open `[auto]` tasks run; `[human]` and `[owner]` are refused.
- Model comes from the tag; untagged means haiku. Render/UI tasks are raised to sonnet (switch off per run). A failed haiku run is retried once on sonnet.
- Limits per task: turns, a dollar cap, and the context size at which a run compacts.
- Stops the batch on: turn cap, no commit, red build.

`runner/run-todos.sh` is also usable on its own: `REPO=/path/to/project runner/run-todos.sh T01 T02` (see its header for env vars).

## Safety

Binds to 127.0.0.1 only, rejects non-localhost Host headers, and requires an `X-Runner` header on every write, so other web pages cannot drive it. Runs execute `claude -p` with `acceptEdits` and a fixed tool allowlist in the registered repo, unattended: only register repos where that is acceptable, and keep the test/build commands trusted.

## Traps

- Run on Windows with Git Bash, not WSL (`C:/...` paths) and not PowerShell-style env syntax.
- Do not edit the TODO file by hand while a batch runs: agents tick boxes in it.
- Vague `Files:` fields make agents search, which is where the cost goes. Name exact paths.
- Measured on a 900-test TS project: bite-size tasks cost about $0.12 to $0.57 on sonnet and about $0.01 on haiku for trivial ones; one oversized task cost $2.05 and hit the turn cap with no commit.
