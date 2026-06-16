# ClaudeBrainDuel Final Report

## Goal
{{goal}}

## Run
- run_id: {{runId}}
- mode: {{mode}}
- status: {{status}}
- started_at: {{startedAt}}
- finished_at: {{finishedAt}}
- branch: {{branch}}
- run_dir: {{runDir}}

## Completed Work
{{summaries}}

## File Changes
{{changedFiles}}

## Commits
{{commits}}

## How To Run
- Initialize: `cbduel init`
- Interactive TUI: `cbduel`
- Headless: `cbduel run "your goal" --mode headless`

## Test Method
- test_command: `{{testCommand}}`
- build_command: `{{buildCommand}}`

## Known Issues
{{knownIssues}}

## Next Suggestions
- Review the final diff before pushing.
- If push is required, run with `--push true` or push the branch manually after checking logs.
- Keep `.cbduel/runs/` local unless you intentionally want to archive run logs.
