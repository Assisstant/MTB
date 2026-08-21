# Staying up to date without carrying JSON

The old routine was: export JSON, carry it, import it, remember which copy was
newer. This replaces it. Nothing here changes what the apps *are* — they still
work offline and still keep their own copy of everything. What changes is that
they now agree with the server by themselves.

## The rule everything follows

The apps are used in one place at a time — work, then home, then work. That is
what makes this safe. There is no merge anywhere in this system and there must
never be one: the state is stored as a single blob, so combining two versions is
not something code can do correctly.

Instead, three things are remembered: what this browser holds, what the server
holds, and **what the two held the last time they agreed**. From that, the
direction is not a guess:

| this side changed | other side changed | what happens |
|---|---|---|
| no | no | nothing |
| no | yes | pull |
| yes | no | push |
| **yes** | **yes** | **stop and ask** |

The last row is the whole point. A timestamp alone would pick the later one and
silently discard the other — which is exactly how a week of work disappears. The
same table governs the browser↔server sync and the work↔home database sync, so
there is only one rule to understand.

## In the apps

In **🖥️ Локален сервер** there is now one button, **🔄 Синхронизирај**, and an
**автоматски** checkbox (on by default). With it on:

- opening the app syncs it
- editing syncs about five seconds after you stop
- leaving the page flushes anything still waiting (S-Dnevnik)

The old **📥 Вчитај** and **📤 Зачувај** buttons are still there, below, for when
you deliberately want to force a direction — including to resolve a divergence.

What the status chip means:

| chip | meaning |
|---|---|
| 🟢 синхронизирано | this browser and the server agree |
| ⚪ серверот не е достапен | working offline; edits are kept locally and go up when it is back |
| 🟠 разидување | both sides changed — nothing was sent, you must choose |
| 🔴 состојбата не е валидна | the local state cannot be exported (e.g. duplicate student names); **sync is stopped until you fix it** |

That last one matters. Previously an invalid state failed quietly and the panel
blamed the server, so you could work for days believing everything was syncing.

## Between the work and home databases

Each machine runs its own PostgreSQL. When both are reachable:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1
```

That is a **report** — it prints both sides and what it would do, and changes
nothing. Add `-Apply` to actually sync:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-peer.ps1 -Apply
```

Put the other machine's address in `server\.env` once, so you never type it:

```
PEER_URL=https://zenpc-1.tailXXXXX.ts.net
```

It follows the same table above. When both databases changed since their last
agreement it refuses and tells you both timestamps, and `-Force` is the only way
past — which is correct, because that case genuinely needs a human.

It also refuses two other ways: an empty state can never replace a full one, and
a state more than 50% smaller than the one it would replace is treated as a
wrong-direction sync rather than an edit.

**Both machines must be awake at the same moment** — only briefly, for the few
seconds the transfer takes. This is the one real constraint. If the work PC is
off every evening and the home PC is off every day, there is no such moment; the
practical answer is to leave the home machine on.

## Doing it without remembering

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1 -Peer https://zenpc-1.tailXXXXX.ts.net
```

Installs three scheduled tasks: the server at logon, a weekly dump + JSON export,
and a peer sync every two hours that stays silent when the other machine is off
(it appends one line to `backups\sync-peer.log`, so a quiet week is provably
quiet rather than merely unreported).

Add `-WhatIf` to see what it would do first, `-Remove` to take them all out.

## Backups

Weekly is enough now: the database is no longer the only copy. Every browser
that opens the apps holds a full copy, and the two machines hold each other's.
The weekly dump exists for the case where all of that is wrong in the same way —
a bad import, a mistaken bulk edit — and you need to go back to a known week.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```

Fourteen dumps are kept by default.

## When something looks wrong

**A device shows old data.** Look at the chip. If it is ⚪, the server is not
reachable from there. If 🟢, that device really is in agreement with the server —
so the newer work is on a machine that has not synced, not lost.

**Divergence you did not expect.** Something saved on the other side while this
one was offline. Nothing has been thrown away: both versions still exist. Decide
which one to keep, then use the explicit button, or `-Force` on the script.

**The chip is 🔴.** Read what it says. It is a problem in the data, not the
connection, and syncing stays stopped until it is fixed — deliberately, because
sending a state that cannot be exported would put a broken copy everywhere.

**Two browser addresses.** `https://assisstant.github.io/...` and
`https://<machine>.ts.net/...` are different origins with separate storage. Work
in one of them consistently. If something is missing, check the other address
before concluding anything was lost.
