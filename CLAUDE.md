# accessng-console — project instructions

Local companion app for the `UberReaderWebInterface` admin project (checked out at
`C:\Users\Lenovo\UberReaderWebInterface`): work tracker + release deploy buttons, served from
`localhost` by a single PowerShell script. See README.md for what it does.

## Identity — this repo is Ivan's personal account

Commits here are `johnivanpuayap <johnivanpuayap@gmail.com>`, set via `git config --local`; the
work repo uses `ereflectivan`. `gh`'s active account is already `johnivanpuayap`, so `gh` and
`git push` work here without `gh auth switch` — never switch accounts globally. Never add a
`Co-Authored-By` or any AI trailer.

## The repo is PUBLIC

`data/`, `logs/` and `config.local.json` are git-ignored and must stay that way — `data/` holds
Ivan's private issue comments. Never commit anything from the work repo either: no connection
strings, FTP credentials, customer data, or account/district ids. Deploys shell out to the work
repo's own script precisely so its credentials never come here.

## `data/` is live user data, not fixtures

`data/tracker.json` and `data/history.jsonl` are Ivan's real working state. Before any script that
rewrites them, copy the file into `data/backups/` first. Never wipe them to "start clean", and
never leave test issues or test history entries behind — remove them and their history lines.

Two rules the app enforces and code must not weaken:

- A **closed** issue (`done` or `declined`) is a permanent record. `Write-Tracker` refuses any save
  that drops one; only `?replace=1`, which the page sends solely from Restore, may replace the set.
- `history.jsonl` is append-only and never rewritten by an import.

## Running and verifying

`Start console.cmd` (or the "accessNG Console" Desktop shortcut) → http://localhost:8790/.

- Restart it after editing `server.ps1`; `public/` is served from disk, so a browser reload is
  enough for HTML/CSS/JS.
- **Never launch it as a tracked background task** — the task runner reaps it. Use
  `Start-Process cmd /c start "" "Start console.cmd"` so it outlives the session.
- Verify user-visible changes in the running app with Playwright MCP, including the partial states
  (a status change re-renders the whole list; re-query the DOM after every step rather than holding
  a stale element reference).
- **Never fire a real deploy to test.** Copy the server to a scratch dir and stub the git and
  deploy steps in `$runTemplate`; that also covers the failure path. Real deploys are Ivan's call.

## PowerShell 5.1 traps that have already cost time

- `[Parameter(ValueFromRemainingArguments)][string[]]` joins an array literal into ONE
  space-separated string. Use a plain `[string[]]` param and pass the array.
- `Start-Process -PassThru` + redirection can report `$proc.ExitCode` as null after `HasExited`.
  The run script writes its code to `<log>.exit` and the server reads that.
- Native `git commit -m` with a multi-line here-string containing `"` gets re-split by argument
  quoting. Write the message to a file and use `git commit -F`.
- `Invoke-RestMethod` swallows the body of a non-2xx response; read error bodies from the browser
  with `fetch` instead.

## Style

No code comments unless they prevent a future bug — a non-obvious constraint or a trap that cannot
be expressed in code. Don't narrate what the code does. One logical change per commit; explain the
reasoning in the commit message, not the source.
