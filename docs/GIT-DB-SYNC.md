# Carrying the database through GitHub

One command at the end of the day on one machine, one command at the start of
the day on the other. Code and database travel together, both through GitHub.

This replaces pCloud as the *active* transport. It does not replace the weekly
local dumps under `backups\`, and it changes nothing about how the sync decides
what to do — `manual-db-sync.ps1` still does all of that.

## Why there are two repositories

`Assisstant/MTB` is **public**, and GitHub Pages publishes it as a website. A
database dump committed there is not a file hidden in a repository; it is a
downloadable file on a live public site, with every child's name in it. That is
why rule 1 exists and why the name guard runs before every commit.

So the database gets its own repository, and that one is **private**:

| repository | visibility | carries |
|---|---|---|
| `Assisstant/MTB` | public, GitHub Pages | HTML screens, server, migrations, tests, scripts |
| `Assisstant/MTB-data` | **private** | PostgreSQL snapshots and the two legacy JSON exports |

Private repositories are free and unlimited on GitHub. The only rule about the
second one is the one that matters: **it must never become public, and GitHub
Pages must never be enabled on it.**

## One-time setup

Once on GitHub:

1. New repository, name `MTB-data`, visibility **Private**. No README, no
   `.gitignore`, no licence — leave it empty; the first push fills it.

Then on **each** machine, next to the MTB folder:

```powershell
cd C:\Users\Admin\Documents\GitHub
git clone https://github.com/Assisstant/MTB-data.git
```

That is all. `scripts\git-sync.ps1` finds `MTB-data` beside the repository on
its own, and `SYNC_NAME` in `server\.env` already says `home` or `work`. If the
clone has to live somewhere else, add one line to `server\.env`:

```
GIT_SYNC_DIR=D:\somewhere\MTB-data
```

Nothing else in `server\.env` changes. `SYNC_DIR=P:\MTB-sync` stays as it is, so
the independent weekly pCloud snapshot keeps running as a separate backup.

## The routine

**Finishing on this machine** — commit your code first, then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Push
```

It pushes the committed code, exports a verified snapshot of this database into
the private clone, and pushes that. It refuses if there are uncommitted changes
to tracked files, because a database that the other machine cannot reproduce
with the code it has is the thing worth preventing. `-Force` pushes the database
alone if you really mean it.

**Starting on the other machine:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull
```

That pulls both repositories and prints the comparison — which tables differ,
whether the schema matches — and **writes nothing**. When the report is what you
expected:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1 -Mode Pull -Apply
```

A verified dump of the local database is taken first, into
`backups\manual-sync\pre-import\`, before anything is replaced. If the restore
fails for any reason, that dump is put back automatically.

**Any time, to see where things stand without touching anything:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\git-sync.ps1
```

## What has not changed

The rule is still **one editing machine at a time**. Nothing here merges two
databases, and nothing here ever will: several tables use local numeric ids, so
two independent inserts on the two PCs can carry the same id while describing
different children. Accepting a snapshot is replacing, not merging, and it is
always a deliberate command.

Code is pulled before the database, always. `manual-db-sync.ps1` refuses a
snapshot whose migration list does not match the working tree, which is the
check that stops a newer database landing on older code.

## Two things to know about the private repository

**Every push adds a full snapshot to its history.** A snapshot is roughly a
megabyte — the dump plus the two JSON exports. The script keeps only the two
newest snapshot folders in the working tree, so a fresh clone stays small, but
the history still grows by about a megabyte per push. After a school year of
daily use that is a few hundred megabytes, which GitHub tolerates but does not
enjoy. When it gets uncomfortable, the repository is transport and not an
archive: delete it, create it empty again, and push once from whichever machine
is authoritative. The real history lives in `backups\` on both machines.

**Checksums are over exact bytes.** The clone gets a `.gitattributes` with
`* -text` and `core.autocrlf false` on its first push. Do not remove them. If
git ever rewrites a line ending inside a snapshot, the SHA-256 in `manifest.json`
stops matching and the other machine reports a corrupted snapshot — which is
correct behaviour, and very confusing to debug.

## If something refuses

| message | what it means |
|---|---|
| `Uncommitted changes in the code repository` | commit them, or `-Force` to send the database alone |
| `Pulling the code repository failed` | local commits or edits block a fast-forward; sort the code repository out first, the database was not touched |
| `The <machine> machine has not published a snapshot yet` | the other side has not run `-Mode Push` since the private repository was created |
| `schema: DIFFERENT - git pull is required` | the code pull did not bring what the snapshot expects; check which branch you are on |
| `The data folder must not be inside the public MTB repository` | the clone is in the wrong place; it must be a sibling of MTB, not inside it |
| `The data clone points at the public code repository` | `git clone` was run against the wrong URL |

## A note for the first run on PCW

If the MTB clone on PCW is older than **5 September 2026**, do not pull into it —
history was rewritten that day. Clone MTB fresh first, as
`docs\PONEDELNIK-PCW.md` says, and only then clone `MTB-data` beside it.
