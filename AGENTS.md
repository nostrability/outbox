# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Session End Checklist

Work is NOT done until pushed to remote.

```bash
git pull --rebase && bd sync && git push && git status
```

- File issues for remaining work before ending
- Close finished issues, update in-progress items
- Never stop before `git push` succeeds
