#!/usr/bin/env bash
# Generic todo runner: one fresh `claude -p` session per task from a project's TODO file, sequentially.
# usage: REPO=/path/to/project runner/run-todos.sh T11 T12 T13
# env:   REPO (required)       project root; the sessions run there
#        TODO_FILE=docs/TODO.md   task list, relative to REPO
#        DATA_DIR=$REPO/.todo-runner   where logs/ and costs.tsv go (the dashboard sets this per project)
#        TEST_CMD="npm test"  BUILD_CMD="npm run build"   must pass before each commit
#        ALLOWED_BASH="npm run *;npm test;npx vitest:*;npx tsc:*"   extra Bash patterns, ';'-separated
#        CLAUDE_BIN=claude    path to the claude executable if not on PATH
#        ALLOW_DIRTY=1        start with uncommitted changes (otherwise refuses)
#        MAX_TURNS=60  MAX_BUDGET_USD=1.50  AUTOCOMPACT=150000   per-task limits
#        VISUAL_FLOOR=0       let haiku take render/UI tasks (default: they are raised to sonnet)
# Only open `[auto]` tasks run. A task line may carry {haiku}, {sonnet} or {opus}; untagged means haiku.
# A failed haiku run (turn cap, no commit) is retried once on sonnet. Every run is appended to logs/costs.tsv.
set -u
REPO="${REPO:?set REPO to the project path}"
TODO_FILE="${TODO_FILE:-docs/TODO.md}"
DATA_DIR="${DATA_DIR:-$REPO/.todo-runner}"
TEST_CMD="${TEST_CMD:-npm test}"
BUILD_CMD="${BUILD_CMD:-npm run build}"
CLAUDE="${CLAUDE_BIN:-claude}"
cd "$REPO" || { echo "cannot cd to $REPO"; exit 1; }
LOGS="$DATA_DIR/logs"
mkdir -p "$LOGS"
[ -f "$LOGS/costs.tsv" ] || printf 'task\tmodel\toutcome\tusd\tturns\tcommitted\ttime\n' > "$LOGS/costs.tsv"
[ -f "$TODO_FILE" ] || { echo "no $TODO_FILE in $REPO"; exit 1; }

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "working tree is dirty; commit/stash first or set ALLOW_DIRTY=1"; exit 1
fi

TOOLS=(Read Edit Write Glob Grep "Bash($TEST_CMD)" "Bash($BUILD_CMD)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git status)" "Bash(git diff:*)")
IFS=';' read -ra EXTRA <<< "${ALLOWED_BASH:-npm run *;npm test;npx vitest:*;npx tsc:*}"
for p in "${EXTRA[@]}"; do TOOLS+=("Bash($p)"); done

# The rules block of the TODO file goes into the prompt, so the agent need not open the whole file.
rules=$(awk '/^## Rules for every task/{f=1;next} /^## /{f=0} f' "$TODO_FILE")

# run_one <id> <task line> <model> [retry]  -> sets OUTCOME and COMMITTED
run_one() {
  local id="$1" task="$2" model="$3" retry="${4:-}" before out
  before=$(git rev-parse HEAD)
  local note=""
  [ -n "$retry" ] && note="A cheaper model already tried this and failed. Run git status and git diff first: uncommitted work may exist; finish or redo it."

  "$CLAUDE" -p "Rules:
$rules

Your task (from $TODO_FILE):
$task

Start from the files named in the task and its Docs. Do not explore the repo, do not search legacy/ or node_modules, and do not read handover notes or the whole of $TODO_FILE. If the code already does what the task asks, change nothing except ticking the box.
Run the one relevant test file first; run '$TEST_CMD' and '$BUILD_CMD' once, just before committing.
When done: tick this task's box in $TODO_FILE (edit that one line only), then make one commit. If blocked or it needs an owner decision, change nothing and say why in one line. $note" \
    --model "$model" \
    --permission-mode acceptEdits \
    --allowedTools "${TOOLS[@]}" \
    --max-turns "${MAX_TURNS:-60}" \
    --max-budget-usd "${MAX_BUDGET_USD:-1.50}" \
    --autocompact "${AUTOCOMPACT:-150000}" \
    --output-format stream-json --verbose > "$LOGS/$id.jsonl" 2> "$LOGS/$id.err"

  out=$(node -e 'const fs=require("fs");let r=null;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const j=JSON.parse(l);if(j.total_cost_usd!==undefined)r=j}catch{}}if(!r){console.log("no_output\t0.00\t0\t");process.exit()}console.log([r.subtype||"success",(r.total_cost_usd||0).toFixed(2),r.num_turns||0].join("\t")+"\t"+String(r.result||"").replace(/\s+/g," ").slice(0,400))' "$LOGS/$id.jsonl")
  OUTCOME=$(echo "$out" | cut -f1)
  COMMITTED=no; [ "$(git rev-parse HEAD)" != "$before" ] && COMMITTED=yes
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$model" "$OUTCOME" "$(echo "$out" | cut -f2)" "$(echo "$out" | cut -f3)" "$COMMITTED" "$(date +%Y-%m-%dT%H:%M:%S)" >> "$LOGS/costs.tsv"
  echo "$id [$model] $OUTCOME \$$(echo "$out" | cut -f2) $(echo "$out" | cut -f3) turns, committed=$COMMITTED | $(echo "$out" | cut -f4)"
  # a commit must leave the build green
  if [ "$COMMITTED" = yes ] && ! bash -c "$BUILD_CMD" >/dev/null 2>&1; then OUTCOME=build_red; fi
}

for id in "$@"; do
  task=$(grep -E "^- \[ \] $id " "$TODO_FILE" | head -1)
  [ -z "$task" ] && { echo "$id: not found or already done, skipping"; continue; }
  case "$task" in *"[auto]"*) ;; *) echo "$id: not tagged [auto], refusing"; continue ;; esac
  model=$(echo "$task" | grep -oE '\{(haiku|sonnet|opus)\}' | head -1 | tr -d '{}')
  model="${model:-haiku}"
  # Visual/UI work never goes below sonnet, whatever the tag says (override: VISUAL_FLOOR=0).
  if [ "${VISUAL_FLOOR:-1}" = 1 ] && [ "$model" = haiku ] && echo "$task" | grep -qE 'src/render|\.tsx|\.css|PartArt|Hud\.|NetPanel|screenshot|visual'; then
    model=sonnet; echo "$id: visual/UI task, floor raised haiku -> sonnet"
  fi
  task=$(echo "$task" | sed -E 's/ *\{(haiku|sonnet|opus)\}//')
  echo "== $id =="

  run_one "$id" "$task" "$model"
  if [ "$model" = haiku ] && { [ "$COMMITTED" = no ] || [ "$OUTCOME" != success ]; } && [ "$OUTCOME" != no_output ]; then
    echo "$id: haiku failed, retrying once on sonnet"
    run_one "$id" "$task" sonnet retry
  fi

  case "$OUTCOME" in
    no_output) echo "$id: claude did not run, stopping"; break ;;
    error_max_turns) echo "$id: hit the turn cap, stopping; review git status"; break ;;
    build_red) echo "$id: build failing after commit, stopping"; break ;;
  esac
  [ "$COMMITTED" = no ] && { echo "$id: no commit made (blocked?), stopping"; break; }
done
exit 0
