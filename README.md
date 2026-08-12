# accessNG Console

Local companion app for the `UberReaderWebInterface` admin project: the work tracker and the
release deploy buttons in one place, running on your own machine.

```
"Start console.cmd"        -> http://localhost:8790/
```

Nothing is hosted anywhere. The server is a single PowerShell script (`server.ps1`) bound to
`localhost` only, and every `/api/` call carries a per-run token that is injected into the page,
so another site open in your browser cannot drive a deploy.

## Tracker

Issues with a permanent `#num`, optional ticket key, description, area, priority, deadline,
subtask checklist, status (`open` / `in progress` / `waiting` / `done`) and private comments.

- The **Today** strip counts overdue, due-in-7-days, high-priority and in-progress issues; click
  one to filter by it.
- Search covers titles, descriptions, subtasks, comments and `#num`.
- Everything saves to `data\tracker.json` as you type. Each save rolls the previous file into
  `data\backups\`, keeping the last 40.
- **Backup** downloads the whole thing as JSON. **Restore** imports one back, and accepts the
  export format of the older claude.ai tracker artifact as well.

Comments are deliberately local and private — they are never sent anywhere.

## Deploy

Drives the repo's own `.claude\skills\deploy-accessng\deploy-accessng.ps1`, so the FTPS
credentials stay in that repo and are never copied here.

- **Cut & deploy accesstest** — pushes `structure_update` to `release/test/<today>` (creating it,
  or fast-forwarding it if it already exists), then builds and uploads to accesstest.
- **Promote & deploy accessNG** — pushes the newest `release/test/*` commit, unchanged, to
  `release/ng/<today>`, then builds and uploads to accessNG. Arms on first click and needs a
  second click to fire.

Guards, all enforced before anything is uploaded:

- Branch work uses refspec pushes only, so the repo's working tree is never checked out and it is
  safe to run while you have unrelated work in progress.
- The promoted commit must equal the tested candidate the page showed you; if `origin` moved in
  between, the run aborts and asks you to refresh.
- An existing `release/ng/*` branch is never moved — a same-day second release goes to
  `release/ng/<date>b`.
- The deploy script's own branch↔environment pairing still applies (`release/test/*` can only
  reach accesstest, `release/ng/*` only accessNG).
- The remote folder is backed up before every upload; a failed deploy leaves the previous release
  live.

The page shows what is on each environment, whether it is behind master, and the exact commit
list that a deploy would ship.

## Configuration

`config.json` holds the port and the path to the repo:

```json
{ "port": 8790, "repoRoot": "C:\\Users\\Lenovo\\UberReaderWebInterface" }
```

`config.local.json` overrides it and is git-ignored. `-Port` and `-RepoRoot` on the command line
win over both.

## What is not committed

`data\` (your issues and their backups) and `logs\` (deploy transcripts) are git-ignored — the
repo holds the app, not the working data. Use **Backup** for a copy you can keep elsewhere.
