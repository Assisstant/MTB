# PCW: почни од тука

9 септември 2026. Ова упатство го заменува претходниот почетен аудит.

## Што е завршено

- Поправките се зачувани на HOME во `codex/private-mtb-readiness`.
  **Од оваа задача не е направен push на GitHub.** Обичен pull на PCW нема да ги донесе.
- Подготвен е `mtb-reviewed.bundle`: пакет со Git кодот за пренос без GitHub.
  Не содржи PostgreSQL база, `.env`, лозинки или локални извози.
- **PCW сè уште нема добиено копија од HOME базата.** Кодот и податоците се пренесуваат одделно.

## Твоите три чекори на PCW

1. Притисни **Windows + E**. Во адресата на File Explorer внеси:

   `P:\MTB-sync\diagnostics\PCW-2026-09-09`

   Отвори **START-HERE.txt**. Ако папката уште ја нема, почекај pCloud да ја преземе.

2. Во Codex на PCW избери ја постојната проектна папка:

   `C:\Users\Admin\Documents\GitHub\MTB`

   Засега остави ја гранката како што е. Истиот Codex профил не го заменува
   преносот на локалниот код и базата.

3. Испрати му го следниот текст на Codex на PCW:

   > Прочитај P:\MTB-sync\diagnostics\PCW-2026-09-09\START-HERE.txt и продолжи според техничкиот дел. Ова е WORK инсталацијата, иако компјутерот физички е дома. Зачувај ја мојата постојна гранка и незачуваните промени. Спореди го вчерашното сработено со подготвениот HOME код, без push или merge во main. Подготви ја проверената верзија од bundle и кажи што од вчера останува посебно. Базата чека на условот за пренос подолу. Не повторувај големи тест-пакети.

**Не треба сам да пушташ PowerShell скрипти.** Codex прво ќе ја провери гранката.

## Што со гранката од вчера?

`Push` ја испраќа гранката на GitHub; `merge` ги спојува измените со друга гранка.
Push на посебна гранка сам по себе не го менува `main`. Но прво треба да се
спореди содржината: дел можеби веќе е решен, а дел може да е корисна независна
промена. Codex ќе ја зачува старата гранка локално и ќе ги издвои потребните
измени. **Не ја бриши и не ја спојувај наслепо.**

## Условот за базата

Веќе е одобрено HOME да биде изворот и PCW да добие точна копија, со резервна
копија од старата PCW база. Не е потребно повторно избирање која база победува.

Испраќањето на целосните ученички и клинички податоци во `P:\MTB-sync` беше
одбиено од автоматската проверка за одобрување: побара изречна дозвола за таа
надворешна pCloud папка. Таа дозвола сè уште не е добиена. Овој водич и
продолжувањето со кодот не се дозвола за испраќање на базата.

Ако го избираш pCloud преносот, во HOME разговорот кажи дека дозволуваш
целосната HOME база да се пренесе во `P:\MTB-sync` за PCW. Потоа HOME задачата
ќе го доврши преносот. Старите snapshots не се замена за подготвената копија.

## Технички дел — за Codex на PCW

1. Read local `AGENTS.md` and `docs/APP-CONTRACT.md`. The 8 September PCW audit
   reported role `work`, PostgreSQL 18.6, 27 migrations, stopped API and no
   Therapy tasks. HEAD was `7ad9cdf46842811c725f5dc203293f68a5ac23d6`; the owner
   now reports another branch, so inspect the current branch, HEAD and dirty
   state. Keep raw diffs and any real names in ignored local files.
2. Verify `.env`, `backups/` and dependencies are ignored. Preserve the current
   branch under a distinct local `codex/` reference and dirty work in a local
   stash including untracked files if needed. Record the stash id. No reset,
   clean, forced checkout, blind stash reapplication or upload of recovery refs.
3. Read the adjacent `completion-manifest.json`. Verify the SHA-256 of
   `mtb-reviewed.bundle`, `git bundle verify`, and its advertised HEAD against
   `targetCommit`. Fetch only its HEAD from the local bundle. No network pull,
   push or merge into `main`. Reviewed HOME changes include `a8a8c66`, `3c3b4c3`,
   `3bbaac1`, `4f89b1e`, `be51869`; the package target may also include this guide.
4. Inspect ancestry and PCW-only changes locally. If the old branch does not
   descend from the cleaned base above, preserve it and stop integration:
   pre-rewrite history must not return to GitHub. Classify unique work as
   already covered, useful independent changes, or requiring a decision.
5. Preserve any existing `codex/private-mtb-readiness` with independent work
   under a distinct local name before reusing the name. Select the exact package
   target on that branch without discarding yesterday's branch. Keep PCW's own
   `.env` and `SYNC_NAME=work`; set `core.hooksPath=.githooks`. Defer cherry-picks
   onto the installation branch until the exact-target completion is finished.
   Run the name guard before any later publication; never push old recovery refs.
6. **Database gate:** require explicit upload authorization and HOME's actual
   transfer completion. The prepared snapshot is
   `home-2026-09-08-20-10-28-0d369154`, still local to HOME under ignored
   `backups/pcw-transfer/`. Its database fingerprint is
   `2eede1f28bef67928db13f57df8c3a0d1d878dcf6e5d713f19a5dafec63159fc`.
   Require this exact current id and all file checksums. Do not substitute an
   older snapshot or infer upload permission from this document.
7. Only after those conditions hold, read the adjacent `finish-PCW.ps1`, then
   run this on PCW:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File P:\MTB-sync\diagnostics\PCW-2026-09-09\finish-PCW.ps1
   ```

   It requires the audited base or exact package target. It preserves source
   edits, compares once, makes a verified PCW safety dump, accepts HOME and
   checks the restored fingerprint. Then it installs hidden independent API
   startup with `-SkipGitPull`, private Tailscale Serve and weekly backup/export
   tasks. It never enables Funnel or automatic peer acceptance. Resolve any
   refusal from evidence; do not remove guards to bypass an unexpected branch,
   running server, conflicting tasks or incomplete package.
8. A local `database-accepted-<snapshotId>.json` records restoration before
   service setup. If setup subsequently fails, resume setup from that receipt;
   never repeat the restore over later PCW edits. Return a short report with
   branch/commit, preservation location, restore status, API role/health and
   private URL. Share only the names-free receipt/audit in this diagnostics
   folder, never `.env`, pupil data or raw logs. No broad test reruns.

## Следна сесија

Preserve the tested personal S-Dnevnik. Continue toward one workspace for annual
lists, therapist pupil selection, cabinet schedule and teaching using the
existing Fusion entry point and APIs. The full UI merge, colleague authorization
rollout and GitHub private cutover are not completed yet. The current task is
finishing PCW and preserving yesterday's work, not starting another UI rewrite.
