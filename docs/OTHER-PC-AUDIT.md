# Continue on the reinstalled PC

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
