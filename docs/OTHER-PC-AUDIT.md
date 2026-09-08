# Continue on the reinstalled PC

The portable [audit script](../scripts/audit-installation.ps1) can now collect
the initial facts without opening another coding task. It is read-only except
for one explicitly requested JSON report; it never starts services, imports,
changes access settings or runs commands received from another machine.
The report contains configuration-presence flags and aggregate hashes/counts,
not passwords or pupil names. Snapshot metadata presence is not checksum proof.

For PCW, after the reviewed script reaches the existing pCloud diagnostics
folder, run this once in PowerShell on PCW:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File P:\MTB-sync\diagnostics\audit-installation.ps1 -OutputPath P:\MTB-sync\diagnostics\PCW-audit-2026-09-08.json
```

It only auto-selects a single recognized local checkout. If the report says
`not_found_pass_RepoRoot` or `multiple_candidates_pass_RepoRoot`, supply that
PC's actual `-RepoRoot` and choose a new report filename. Do not point it at
another machine's repository or overwrite the first report. When pCloud has
transferred the report, the coordinating task on HOME can read it directly.
This is a diagnostic handoff, not a remote shell.

For further local investigation:

Open this PC's actual MTB checkout in a local Codex task. A permission in the
other PC's conversation does not itself establish a remote shell here. The
machine may be physically at home while still being the WORK installation.

Paste this prompt into that task:

> Read AGENTS.md and docs/APP-CONTRACT.md, then docs/PLAN-private-mtb.md if
> available. Audit this reinstalled PC without changing database data or
> settings. Locate the active checkout, inspect git status and verify this is
> a fresh post-history-rewrite clone before any pull or push. Check the local
> SYNC_NAME rather than inferring WORK/HOME from location or hostname. Read
> DATABASE_URL locally without printing credentials. Verify PostgreSQL, API
> health, applied migration filenames, aggregate table counts by school year,
> Cyrillic matching, backup readability, Tailscale Serve/Funnel and the exact
> Therapy scheduled-task actions. Report names-free findings and the minimum
> proposed corrections. Do not run migrations, imports, ACCEPT, Force,
> installation, cleanup or public publishing. The attached old plan's empty
> PCW and September 5 snapshot are historical claims, not today's authority.
> Both PCs need independent offline operation; colleagues normally edit WORK
> during the same shift. Transfer should be manual before changing locations.

Return that audit here. For a limited check from the other PC, the existing
Tailscale HTTPS `/api/health` address is sufficient; it does not grant Windows
administration or database access. Do not send passwords, service keys, pupil
exports or a publicly shared database link.

This branch's plan is local until deliberately committed and transported. If
the other checkout has not received it, the prompt above is self-contained;
do not try to pull from a pre-rewrite clone to obtain it.
