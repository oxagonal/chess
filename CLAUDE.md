# Working on this repo

Chess Prep: a local-first opening trainer (React + Vite + Dexie/IndexedDB), deployed as a static site on
Cloudflare. See README.md for features and the project layout.

## Saving work — do it automatically, don't ask

The owner doesn't want to be asked about pull requests, merging or pushing. `main` is the production
branch: Cloudflare deploys every push to it.

1. Before starting, bring the session branch up to date: `git fetch origin main && git merge origin/main`.
2. After each finished change, run `npm test` and `npm run build`. If both pass, commit, then push the
   session branch **and** `main` (`git push origin HEAD:main`). Never force-push `main`; if the push is
   rejected, merge `origin/main` and push again.
3. Don't open pull requests unless asked. If tests or the build fail, fix them rather than pushing.

## Checks

- `npm test` — vitest unit tests (src/test)
- `npm run build` — typecheck + production build into dist/
- `npm run dev` — local dev server on http://localhost:5173

## Things to keep in mind

- All user data lives in the browser (IndexedDB). Schema changes need a new `db.version(n)` in
  src/db/db.ts — never edit an existing version.
- Device sync (src/services/cloudSync.ts, src/lib/syncMerge.ts) relies on every write to a synced table
  going through Dexie, which stamps `modifiedAt`. A new table holding user data must be added to
  `SYNC_TABLES` (and to the backup's table list in src/services/backup.ts).
