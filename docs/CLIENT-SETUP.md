# Using this PC as a plain client

This machine installs **no PostgreSQL, no Node, no server**. It opens a browser
at the server PC's address and that is all. The only thing installed here is
Tailscale, because without it the two machines cannot see each other.

> **Do not run `scripts\setup-home-postgres.ps1` on this machine.** That would
> create a second database — the exact situation `CLAUDE.md` warns about. Two
> live databases cannot be merged, only carried.

---

## Why raw IP addresses will not work

`server/src/index.ts` binds to `127.0.0.1`, so the API answers only calls that
originate on the server machine itself. `http://100.x.x.x:3000` from this PC
will always fail — it is not a firewall problem and opening ports will not fix
it.

Tailscale's `serve` is the supported way in: it listens on the tailnet and
forwards into `localhost:3000` on the server machine. It also gives an
**https** address, which matters — the published apps on
`https://assisstant.github.io` cannot call a plain `http://` server, because
browsers block mixed content.

---

## PART A — On the SERVER PC (once)

The machine you picked as the server. Skip A1/A2 if they are already done.

**A1. The server must be running.** In the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-server.ps1
```

Leave the window open. (`docs/HOME-SETUP.md` PART E makes it start at logon.)

**A2. Expose it on the tailnet:**

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
```

It prints an address like `https://work-pc.tailXXXX.ts.net`. **Write it
down** — that address is the whole setup. `--bg` means it survives reboots.

To see it again later:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve status
```

---

## PART B — On this PC (once)

**B1. Install Tailscale:**

```powershell
winget install Tailscale.Tailscale
```

Sign in with the **same account** as the server PC. Nothing else gets
installed.

**B2. Check the server answers.** Open in the browser:

```
https://<name>.ts.net/api/health
```

You should see `{"ok":true,"db_time":...}`. If not, stop here — the problem is
on the server side, not this one (see the table at the bottom).

**B3. Bookmark exactly these two addresses:**

```
https://<name>.ts.net/Rasporedi-Unified-Sync-v5.0.html
https://<name>.ts.net/S-Dnevnik-Blagoj-Unified-Sync-v4.html
```

Served by the server itself, so the server address fills in by itself — there
is nothing to type in the **🖥️ Локален сервер** panel.

Also useful: `https://<name>.ts.net/Pregled-Baza.html` for a read-only look at
the database.

---

## PART C — The one rule on a fresh machine

The apps are local-first: each browser keeps its own copy of everything. A
browser that has never opened these apps **holds nothing**.

> **First action, always: 📥 Вчитај од сервер.**
>
> If you press **📤 Зачувај на сервер** first on a fresh browser, you are
> sending an empty state over a year of work. `import-core.ts` has a safeguard
> that refuses an empty payload and says so — but do not lean on it.

Then the daily rhythm is the same as everywhere else:

1. **📥 Вчитај од сервер** when you sit down
2. work
3. **📤 Зачувај на сервер** when you finish

A save should say *„базата е ажурирана"*. If it says the database was **not**
updated, load from the server first, check, then save again.

**One address, always.** `https://<name>.ts.net/...` and
`https://assisstant.github.io/...` are different origins with separate browser
storage. Work in one, and what you typed is invisible in the other. Pick the
tailnet address and stay there.

---

## PART D — Your phone

Same address, nothing to install beyond Tailscale (App Store / Play Store,
same account). Open `https://<name>.ts.net/S-Dnevnik-Blagoj-Unified-Sync-v4.html`.
The same PART C rule applies: pull before you touch anything.

---

## What about the clone in `C:\Users\Admin\MTB`?

Not needed for client work — the apps come from the server. Keep it for
`CLAUDE.md` and the docs (and so a Claude Code session here starts with the
project context), or delete it. It holds no data and no `.env`.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` does not load | server PC off, or `run-server.ps1` not running | start it on the server PC (A1) |
| Health loads but apps 404 | `serve` points at the wrong port | rerun A2 with `3000` |
| App opens completely empty | new address = new browser storage | press **📥 Вчитај од сервер** |
| „Серверот не е достапен" | Tailscale signed out on one side | check both machines are in the tailnet |
| Blocked / mixed-content error in console | you typed an `http://` address into the published app | use the `https://…ts.net` address |
| Your work is missing after switching machines | you were on two different origins | check the other bookmark before assuming data loss |

Nothing on this machine is the source of truth. If this PC is wiped, nothing
is lost — the database on the server PC and its backups hold everything.
