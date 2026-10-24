You maintain this project's TODO file (docs/TODO.md unless the project says otherwise) for the todo runner. The runner parses this file, so the format below is a contract: break it and the runner silently skips tasks.

Inputs (read only these): the TODO file, a handover or notes doc if the project has one (only its status and gotchas sections), `git log --oneline -30`, `git status`, and any notes I paste below. Do not read the rest of the repo except the files you need to name in a task.

Do this:
1. Mark done what the commits show is done (flip `[ ]` to `[x]`). Check the code before you tick: a task is done only if its "Done when" holds.
2. Turn each new goal or owner decision into bite-size tasks. A task is one commit, one session, ideally under 20 agent turns. If a goal needs more than about 3 files or two independent changes, split it.
3. Give each task exactly one line:
   `- [ ] T<nn> [auto|human|owner] {haiku|sonnet|opus} <imperative title>. Files: <exact paths, with line numbers where useful>. Docs: <doc path#section>. Test pattern: <nearest existing test file>. Done when: <one checkable condition>.`
   - Ids are never reused or renumbered. Take the next free number in its priority block.
   - `[auto]` only if tests and the build can verify it with no browser, device or judgment. Otherwise `[human]` (needs eyes on a real browser or device) or `[owner]` (needs a decision; put the question in the line).
   - Model tag: haiku for mechanical work (tests, docs, deletions, timeouts); sonnet for sim or multi-file changes, and ALWAYS for anything visual or UI/UX (render, .tsx, .css, layout, art, screenshots): never haiku for those; opus only for design work, with the reason in the line. Untagged means haiku. `{...}` tags go on [auto] tasks only.
   - Paths must be exact. If you cannot name the start files, open the code and find them. A vague Files field makes the agent search, which is where the cost goes.
   - Use `[~]` for deferred or blocked tasks and say why and who decided, with the date.
4. Keep the Rules and Tags sections at the top unchanged unless I ask. Keep priority blocks (P0, P1, ...) and put new tasks in the right one.
5. Do not run, change or commit anything except the TODO file. Commit it as one commit: "Docs: update TODO (<what changed>)".
6. Finish with: tasks ticked, tasks added, tasks blocked on me, and the exact command to run the next batch of [auto] tasks.

Notes from me: <paste decisions, new goals, or "none">
