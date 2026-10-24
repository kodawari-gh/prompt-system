# TODO (bite-size, one commit each)

Work list for the todo runner. One task = one fresh agent session = one commit.

## Rules for every task

- One task = one commit, touching only the paths listed in `Files`. Stage with `git add <paths>`, never `git add -A`.
- The test and build commands must both pass before the commit. If they cannot, change nothing and say why in one line.
- Read the task's `Docs`, not the whole repo.
- Use the Edit tool, never rewrite a file from a script.
- When done, flip `[ ]` to `[x]` on this task's line only.

## Tags

- `[auto]` an unattended session can finish and verify it with tests and the build.
- `[human]` needs a person in a real browser or on a real device. Never run unattended.
- `[owner]` needs a decision first. Never run unattended.
- Model: `{haiku}` (default, mechanical work), `{sonnet}` (multi-file, sim, anything visual), `{opus}` (design work, give the reason).

Line format (the runner matches `^- \[ \] <ID> `): `- [ ] ID [tag] {model} Title. Files: ... Docs: ... Test pattern: ... Done when: ...`

## P0

- [ ] T01 [auto] {haiku} Example task: replace this line. Files: `path/to/file`. Done when: one checkable condition.
