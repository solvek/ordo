---
name: ship-ordo
description: >-
  Ship a change to Ordo: commit on main, push, rebuild, and reinstall the
  ordo command. Use when changing Ordo, pushing it, rebuilding it, or
  reinstalling it, including when the owner says «зміни ордо», «запуш»,
  «ребілд» or «реінстал».
---

# Ship Ordo

Ordo lives in `/root/Projects/ordo` (github.com/solvek/ordo). The `ordo` command is `/usr/local/bin/ordo`, a symlink to `dist/cli.js`. A dispatcher that is already running keeps the old code until it is restarted. Do not restart it unless the owner asks.

This skill is linked from `~/.cursor/skills/ship-ordo`. Keep that link.

Work on `main`. Do not create a branch.

## Done

From `/root/Projects/ordo`, all of these pass before a commit:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Commit and push

Commit only the Ordo change. Message: imperative summary, then why.

```bash
git push origin main
```

## Rebuild and reinstall

```bash
cd /root/Projects/ordo && pnpm install && pnpm build
ln -sfn /root/Projects/ordo/dist/cli.js /usr/local/bin/ordo
```

Confirm `readlink -f /usr/local/bin/ordo` is `/root/Projects/ordo/dist/cli.js` and `ordo --help` prints the commands.

Say that a running dispatcher is still on the previous build.
