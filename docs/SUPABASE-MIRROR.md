# Supabase → локална копија (фаза 1)

Оваа функција е **deployed на Render, но исклучена по default**. Migration 033
е применета во Supabase на 22 септември; export и локален mirror не се активирани.
Нема mirror база или scheduled pull на HOME/WORK. Увозот во Supabase не се
повторува.

Во фаза 1 Supabase е единственото место за измена. Локалниот mirror е последна
успешно преземена копија само за читање. Без интернет може да се чита, но не и
да се внесува работа што подоцна ќе се испрати. Двонасочно спојување и offline
queue не постојат во оваа фаза.

## Што точно се пренесува

Еден `REPEATABLE READ READ ONLY` snapshot ги зема сите 44 деловни табели за
сите години: списоци, годишни членства, кабинетски и наставен распоред,
присуство, планови, клинички записи, евидентни листови, каталози и `app_state`.
Списокот е експлицитен во `server/src/lib/mirror.ts`; непозната нова табела го
запира export-от додека не се разгледа.

Не се пренесуваат:

- `schema_migrations` — се споредува како ledger, не се препишува;
- `sync_watermark` — стар локален peer договор;
- `mirror_sync_state` и `mirror_sync_attempt` — локален статус;
- `evidence_logins` и `evidence_sessions` — PIN hash-ови и живи сесии.
- `form_replies` и `form_reply_decisions` — сандаче на пристигнати формулари
  (040); прифатените ставки стигнуваат во табелите што се пренесуваат.

Не се пренесуваат Supabase schemas, Google/Render сесии, тајни или PostgreSQL
sequences. Mirror-от е read-only; ако некогаш треба да стане главна база,
sequences се проверуваат одделно во reviewed постапка.

Snapshot-от носи source id, source transaction version, време, migration
ledger, columns/primary keys, број и SHA-256 за секоја табела, стабилен content
hash и SHA-256 за целиот пакет. Затоа нова проверка додека cloud содржината е
мирна е no-op. Ист watermark и исто observation време со различна содржина се
одбиваат. Подоцнежна снимка може да има ист watermark и сменета содржина ако
трансакција што била отворена во првата снимка се commit-ирала меѓу нив.
Endpoint-от е исклучен без `MTB_MIRROR_EXPORT=1` и прифаќа посебен
Bearer key само на `GET /api/mirror/snapshot`. Тој key не отвора друга API рута
и не е cloud DB/service-role credential.

## Безбедна подготовка (не е дозвола за live промена)

Пред пилот треба посебно одобрение за: Render env,
создавање локална база/roles и првото `--apply`.

1. Направи и провери независен Supabase backup/restore во изолирана цел.
2. Создај посебна локална база, на пример `therapy_mirror`; никогаш не ја
   пренаменувај постојната `therapy_dev`.
3. Примени ги проектните migrations во празниот mirror со експлицитен admin URL:

   ```powershell
   $env:DATABASE_URL='postgresql://ADMIN_USER:REPLACE@localhost:5432/therapy_mirror'
   npm run migrate --prefix server
   Remove-Item Env:DATABASE_URL
   ```

4. Направи два локални PostgreSQL roles: app role со `CONNECT`, `USAGE` и
   `SELECT`; sync role со право да ги заменува 44-те деловни табели и да пишува
   во двете `mirror_sync_*` табели. App URL оди во `DATABASE_URL`; sync URL само
   во `MTB_MIRROR_TARGET_DATABASE_URL`. Дополнително, `MTB_MIRROR_MODE=readonly`
   му поставува `default_transaction_read_only=on` на секое обично app/API/import
   поврзување. Migration 036 воведува RLS на новите staff и mirror-ledger табели:
   локалните roles мора да имаат и соодветни RLS policies, не само table grants.
   Точните grants/policies се проверуваат на пилотот; не се погодуваат live.
5. Копирај ги placeholder-ите од `server/.env.example` во игнорираниот `.env`.
   Export key мора да е случаен, отповиклив и најмалку 32 знаци. Истиот secret
   е `MTB_MIRROR_EXPORT_KEY` на Render и `MTB_MIRROR_PULL_KEY` на одобрениот PC.
   `MTB_MIRROR_SOURCE_ID` мора точно да се совпадне со cloud server id.

Cloud кодот останува во primary/write режим (`MTB_MIRROR_MODE=off`). Локалниот
app користи `readonly`. Pull алатката одбива non-local target и име што не
завршува со `_mirror`. Истата цел може да е активната `DATABASE_URL` само кога
апликацијата веќе е експлицитно во `readonly`; `therapy_dev` никогаш не е цел.

## Dry-run и рачно apply

Од repo root:

```powershell
npm run mirror:pull --prefix server
```

Ова презема и целосно проверува snapshot, го зачувува точниот пакет во
gitignored `backups/mirror/`, па по табела прикажува додавања, измени и
бришења. **Не ја менува базата**, но локалниот snapshot фајл содржи вистински
податоци и не смее да се commit-ира или споделува. За apply мора да се употреби
истиот зачуван фајл и повторно да се внесат точниот snapshot id и plan hash што
ги испечатил dry-run:

```powershell
npm run mirror:pull --prefix server -- --apply --snapshot-file "C:\...\backups\mirror\EXACT_ID.json" --snapshot-id EXACT_ID --plan-hash EXACT_HASH
```

Ако се бришат повеќе од 10 реда и повеќе од 20% од локалната содржина,
алатката дополнително бара `--allow-delete-count EXACT_NUMBER`. Apply не
презема нов пакет од мрежата: повторно ги проверува hash-овите на reviewed
фајлот. Локална промена го менува plan hash-от и apply се одбива.

Apply зема transaction advisory lock, ја проверува шемата/ledger-от повторно,
брише и внесува по foreign-key редослед, ги проверува сите табеларни hash-ови и
го запишува успехот во **истата SERIALIZABLE трансакција**. Пад или constraint
грешка ја остава претходната целосна копија. Ист snapshot е no-op; постар source
version се одбива.

## Статус, пауза и rollback

`/api/health` прикажува `mirror.mode`, извор, време на податоците, последен
успешен apply, последен обид и coarse error code. Заедничката лента и launcher-от
ја означуваат базата како „КОПИЈА САМО ЗА ЧИТАЊЕ“. API writes враќаат 423, а
S-Dnevnik не смее да зачува локална измена во mirror режим.

Пауза значи да не се пушта `mirror:pull`; `MTB_MIRROR_MODE=readonly` останува.
Не се исклучуваат backup задачите. За rollback, запре mirror серверот и отвори
ја зачуваната стара локална инсталација/база. Не менувај ја старата база во
primary и не испраќај ништо од неа кон Supabase автоматски.

Предлог по успешен пилот е startup pull и интервал од 10 минути, со еден lock,
60 секунди timeout и најмногу три обиди со backoff. Овој branch **не инсталира
scheduled task**; распоред се активира одделно по одобрение и мерење на товарот.
