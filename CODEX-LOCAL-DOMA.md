# Инструкции за Codex Local — домашниот компјутер

## Цел

Да се пренесе можноста **„Шаблон од пополнет пример“** од Codex Cloud во
локалниот `main`, без губење на туѓи промени, потоа да се провери, commit-ира,
push-ира и да се пушти најновиот commit на Render.

Миграцијата **062 веќе е применета во облакот**. Не ја пуштај повторно и не
отворај, не поправај и не синхронизирај локална или жива база за оваа задача.

## Што треба да имаш

Од Codex Cloud преземи patch направен со:

```bash
git format-patch -1 a85c16d --stdout > template-filled-example.patch
```

Стави го `template-filled-example.patch` во root-папката на локалниот MTB
repository. Не копирај го текстот на patch-от преку Messenger: така може да се
оштетат програмските знаци и кирилицата.

## Prompt за Codex Local

Отвори го локалниот MTB repository во Codex и испрати го следново:

> Прочитај ги целите `AGENTS.md` и `SOSTOJBA.md` пред да менуваш нешто.
> Сопственикот го одобри push-от и Render deploy-от за оваа задача.
>
> Во root се наоѓа `template-filled-example.patch`, извезен од Codex Cloud
> commit `a85c16d`. Пренеси ја можноста „Шаблон од пополнет пример“ врз
> актуелниот локален `main`.
>
> 1. Прво прикажи `git status --short --branch`, `git log -1 --oneline` и
>    `git remote -v`. Не прави reset, clean, checkout на туѓи фајлови или
>    force-push.
> 2. Ако има несочувани промени, не ги презапишувај. Разграничи ги од patch-от
>    и запре пред примена ако истите линии се менувани од друг процес.
> 3. Провери го patch-от со `git apply --stat` и `git apply --check`. Потоа
>    примени го со `git apply --3way`. Ако има конфликт, реши го рачно според
>    тековниот `main`; не земај слепо цел фајл од една страна.
> 4. Не внесувај `.vscode/settings.json` во commit. Намерните фајлови се:
>    `Kolega.html`, `SOSTOJBA.md`, `docs/APP-CONTRACT.md`, `docs/HISTORY.md` и
>    `server/test/kolega-plan.browser.mjs`.
> 5. Провери дека „Преземи“ копира само избрани полиња во отворениот нацрт,
>    предупредува пред замена на непразна содржина, не копира ученик, автор,
>    потврда или историја и не праќа server write. Само обичното „Зачувај“ е
>    вториот чекор што испраќа приспособен текст.
> 6. Од `server/` пушти ги проверките подолу. За browser-тестот употреби го
>    постојниот `CHROME` path ако Playwright Chromium не е инсталиран.
> 7. Прегледај `git diff --check`, `git diff --stat` и целиот `git diff`.
> 8. Ако проверките се добри, commit-ирај ги само петте намерни фајлови со
>    порака `Kolega: reuse filled examples as editable plan templates`, па
>    push на `origin main`. Не додавај го patch-фајлот во Git.
> 9. Потврди дека GitHub `main` го покажува новиот commit како HEAD.
> 10. Потоа во Render избери **Manual Deploy → Deploy latest commit**. Не
>     deploy-ирај стар commit и не ја пуштај повторно миграцијата 062.
> 11. Следи го deploy-от до `Live`, провери `/api/health` и преку cloud
>     адресата провери: Колега → Акциски план → ✏️ Уреди → „Шаблон од
>     пополнет пример“. Потврди дека „Преземи“ не зачувува автоматски, а
>     „Зачувај“ го испраќа приспособениот нацрт.
> 12. Не прикажувај вистински ученички имиња во terminal, лог, screenshot,
>     commit или извештај. На крај пријави GitHub commit SHA, Render deploy ID
>     и резултатот од секоја проверка.

## Команди за проверка

Од `server/`:

```powershell
npm run docs:toc
npm run check:agent-docs
npm run typecheck
npm run check:names
npm run test:kolega-plan
```

Од root-папката:

```powershell
git diff --check
git diff --stat
git status --short --branch
```

## Commit и push

Codex Local прво мора да го прегледа diff-от. Потоа:

```powershell
git add Kolega.html SOSTOJBA.md docs/APP-CONTRACT.md docs/HISTORY.md server/test/kolega-plan.browser.mjs
git commit -m "Kolega: reuse filled examples as editable plan templates"
git push origin main
```

Не додавај `template-filled-example.patch` во commit. По успешниот push може да
се избрише од локалната папка.

## Кога мора да запре

Codex Local треба да запре и да објасни, наместо да погодува, ако:

- GitHub `main` не е очекуваната основа или има непознати локални commits;
- има туѓи несочувани промени во истите линии;
- `git apply --check` или `git apply --3way` не може безбедно да го примени patch-от;
- тест покаже функционална грешка;
- GitHub push-от не е потврден;
- Render нуди deploy на commit различен од новиот GitHub HEAD;
- cloud health или проверката по deploy не помине.

