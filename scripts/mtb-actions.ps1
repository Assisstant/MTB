# mtb-actions.ps1 — what the MTB folder offers, written once.
#
# Dot-sourced by create-shortcuts.ps1 (the .lnk files and the PROCITAJ text
# beside them) and by mtb-launcher.ps1 (the tiles). Three lists of the same
# eight actions would come to say three different things, so this is the only
# place an action, its words or its command is written (owner, 3 Oct 2026).
#
#   Name         the .lnk file name. ASCII: WScript.Shell encodes it with the
#                ANSI codepage, which on these PCs is not Cyrillic.
#   Script/Args  what runs, relative to scripts\
#   Icon         shell32.dll index for the .lnk
#   Description  the .lnk tooltip (ASCII, same reason)
#   Glyph/Color  the tile's icon (Segoe MDL2 Assets, present on Windows 10 and 11)
#   CardColor    the card's own tint at first; either colour is changed on the tile
#   Title/Text/When   what a person reads on the tile and in PROCITAJ
#   Confirm      asked before the tile runs it; the shortcut itself never asks
#   UrlKey       instead of Script: a page, its address read from that key in
#                server\.env. Such an action is a tile and a PROCITAJ entry, no .lnk
#   NeedsEnv     the action exists only on a computer whose server\.env has that
#                key set. The read-only copy is set up on HOME and WORK
#                (7 Oct 2026); a tile for something this
#                computer does not have is a tile that fails. Where the key is
#                missing there is no tile, no .lnk and no PROCITAJ line.
#   Tab          the tab of the Контролна табла the tile sits on (Get-MtbTabs).
#                An action without one is upkeep.
#   Fav          the tile is on „Омилени" until the person chooses otherwise:
#                the star on a tile adds it there or takes it off, and that
#                choice is kept with the layout, not here.
#   Page         with UrlKey: one page of that server — the key's address
#                without its path, then this. A record page is opened where the
#                records are written, in the cloud's work space.
#   File         instead of Script: a page of this folder, opened from this
#                computer. For what needs no server and no Internet.
#   Part         with File: the part of that page to open, after its „#". The
#                exercise page holds the exercises and both tools under one
#                strip, so each of the three tiles opens it on its own part.
#   Thumb        a picture on the tile, relative to the repository's root. This
#                repository is public: a picture of a record page is made with
#                invented data (scripts\tiles\README.md), never from the work.

# The tabs of the Контролна табла. A tab is a kind of thing to do; inside it the
# tiles keep the order, the pins and the colours a person gave them.
#
# Three came first (owner, 8 Oct 2026: „Administracija, Evidencija, Vezbi,
# thumbnails"). On 9 Oct 2026 the owner chose to work only in the cloud („ova
# neka stoi ama da ne upotrebuvam") and asked for what is really used to be
# favourites and for what is not in use to stand apart, „da ne pravat haos":
#   fav      what is opened every day — the person's own choice, by the star;
#   upkeep   what keeps the cloud safe and this computer's code current; the
#            panel's reminders point here;
#   parked   the local server and the read-only copy. Nothing is removed or
#            switched off: they are only out of the way.
# „Администрација" is gone: it had become the tab where the day's work, the
# cloud's upkeep and the unused local server sat side by side.
function Get-MtbTabs {
    @(
        @{ Key = 'fav';      Title = '★ Омилени';     Text = 'Она што се отвора секој ден. Ѕвездата на која било плочка ја додава тука или ја трга.' },
        @{ Key = 'records';  Title = 'Евиденција';     Text = 'Работните екрани — во облакот, каде што се работи секој ден.' },
        @{ Key = 'practice'; Title = 'Вежби';          Text = 'Вежби за изговор и двете алатки — од овој компјутер, и без Интернет.' },
        @{ Key = 'upkeep';   Title = 'Одржување';      Text = 'Облакот: резерва, чистење, надградба — и кодот на овој компјутер. Потсетникот горе кажува кога е време.' },
        @{ Key = 'parked';   Title = 'Не се користи';  Text = 'Локалниот сервер и копијата од облакот. Работат, но се работи само во облакот — тука се за да не пречат.' }
    )
}

# The order and the colours carry the logic (owner, 3 Oct 2026: „by kinship,
# by some logic — importance, order"). Three groups of three, one row each in
# the panel, from the most used to the one that needs care:
#   day      blue    the day's work, most important;
#   often    green   now and then, safe — nothing is stopped or changed;
#   careful  warm    stops or changes something, and asks first;
#   parked   —       the local server and the copy, not in use since 9 Oct 2026.
# Within a group each tile has its own shade of the family, so a row reads
# as one kind of thing and each tile can still be told apart.
function Get-MtbActionGroups {
    @(
        # Title heads a section of PROCITAJ; Word is the same on a tile, which has no sections.
        @{ Key = 'day';     Title = 'Секој ден — најважните';                      Word = 'секој ден' },
        @{ Key = 'often';   Title = 'По потреба — безбедни, ништо не гасат';       Word = 'по потреба' },
        @{ Key = 'careful'; Title = 'Внимателно — гасат или менуваат, прашуваат'; Word = 'внимателно' },
        @{ Key = 'parked';  Title = 'Не се користи — локалниот сервер и копијата'; Word = 'не се користи' }
    )
}

function Test-MtbEnvKey([string] $Key) {
    $file = Join-Path (Split-Path -Parent $PSScriptRoot) 'server\.env'
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    return [bool](Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=\s*\S" } | Select-Object -First 1)
}

# What THIS computer offers: the whole list, less what it is not set up for.
function Get-MtbActions {
    $all = @(Get-MtbAllActions | Where-Object { -not $_.NeedsEnv -or (Test-MtbEnvKey $_.NeedsEnv) })
    foreach ($a in $all) { if (-not $a.Tab) { $a.Tab = 'upkeep' } }
    $all
}

function Get-MtbAllActions {
    $cloudPrompt = 'Адресата на облачниот работен простор, на пример https://…/MTB-Workspace.html'
    @(
        # Daily work is written in the cloud (23 Sep 2026), so it comes first. A
        # tile only, no .lnk: it opens the browser, not a script. Its address is
        # MTB_CLOUD_URL in server\.env — the cloud's address is not written in
        # this public repository — and the tile asks for it once if it is not there.
        @{ Group = 'day'; Name = 'Oblak - rabotna povrshina'; UrlKey = 'MTB_CLOUD_URL'; Glyph = 0xE774; Color = '#1F5FD1'; CardColor = '#1F5FD1'
           UrlPrompt = $cloudPrompt
           Title = 'Облак — работен простор'
           Text = 'Го отвора MTB работниот простор во облакот (Render), во прелистувачот. Таму се работи секој ден, од компјутер и од телефон.'
           When = 'Секој ден, за работа.' },
        # The cloud is the only place the work is written, so its backup is the
        # one copy that matters. Reads the cloud, changes nothing there.
        @{ Group = 'often'; Name = 'MTB - Oblak rezerva'; Script = 'cloud-backup.ps1'; Args = ''; Icon = 'shell32.dll,258'
           Description = 'MTB - cloud (Supabase): a full backup here and in pCloud'; Glyph = 0xE896; Color = '#2E9B4F'; CardColor = '#2E9B4F'
           Title = 'Резерва на облакот'
           Text = 'Целосна резерва на облачната база — и сметките на колегите — во backups\cloud и во pCloud. Само чита од облакот, ништо таму не менува и ништо не прашува.'
           When = 'Еднаш неделно — потсетникот горе кажува кога.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB'; Script = 'mtb.ps1'; Args = ''; Icon = 'shell32.dll,44'
           Description = 'MTB - open the day'; Glyph = 0xE80F; Color = '#0C8CE9'; CardColor = '#0C8CE9'
           Title = 'Отвори го денот'
           Text = 'Влече нов код, прави резерва па ја ажурира базата, го вклучува серверот, ја проверува машината и го отвора S-Дневник. Ако нешто не е во ред, застанува пред да ги отвори апликациите и кажува зошто.'
           When = 'Не се користи: го отвора локалниот дневник, не облакот.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB - Zavrshi den'; Script = 'mtb.ps1'; Args = '-Action stop'; Icon = 'shell32.dll,46'
           Description = 'MTB - backup, publish to pCloud, stop the server'; Glyph = 0xE708; Color = '#6B4FD8'; CardColor = '#6B4FD8'
           Title = 'Заврши го денот'
           Text = 'Резерва на локалната база, снимка во pCloud, па го гаси серверот. Секој чекор се обидува и кога претходниот не успеал, и на крај кажува што не поминало.'
           When = 'Не се користи: ја чува локалната база, не облакот.'
           Confirm = 'Да го затворам денот? Ќе направам резерва и снимка во pCloud, па ќе го исклучам серверот.' },
        @{ Group = 'often'; Name = 'MTB - Azuriraj'; Script = 'mtb.ps1'; Args = '-Action update'; Icon = 'shell32.dll,238'
           Description = 'MTB - pull the code, backup, migrations, restart'; Glyph = 0xE895; Color = '#1E9E8B'; CardColor = '#1E9E8B'
           Title = 'Ажурирај среде ден'
           Text = 'Го носи новиот код од GitHub на овој компјутер — за вежбите и за самата контролна табла — со резерва на локалната база и рестарт на локалниот сервер. Облакот се ажурира одделно: Render → Manual Deploy.'
           When = 'Кога потсетникот горе вели дека кодот е зад GitHub.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB Server - Status'; Script = 'server-control.ps1'; Args = 'status -Wait'; Icon = 'shell32.dll,23'
           Description = 'Therapy server - status'; Glyph = 0xE9D9; Color = '#0097A7'; CardColor = '#0097A7'
           Title = 'Состојба на серверот'
           Text = 'Дали серверот работи, на која адреса и со која база. Само кажува, ништо не менува.'
           When = 'Кога не си сигурен дали е вклучен.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB Server - Start'; Script = 'server-control.ps1'; Args = 'start -Wait'; Icon = 'shell32.dll,137'
           Description = 'Therapy server - start'; Glyph = 0xE768; Color = '#2E9B4F'; CardColor = '#2E9B4F'
           Title = 'Вклучи сервер'
           Text = 'Само го вклучува серверот и чека да одговори. Без ажурирање, без отворање на апликациите.'
           When = 'Кога нешто се поправа.' },
        # The read-only copy of the cloud (docs\SUPABASE-MIRROR.md): only where it is set up.
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB - Kopija od oblakot'; Script = 'mirror-open.ps1'; Args = ''; Icon = 'shell32.dll,22'
           NeedsEnv = 'MTB_MIRROR_READER_DATABASE_URL'
           Description = 'MTB - open the read-only copy of the cloud'; Glyph = 0xE8A7; Color = '#5B6B82'; CardColor = '#5B6B82'
           Title = 'Копија од облакот'
           Text = 'Ја отвора копијата од облакот, само за читање, и го вклучува нејзиниот сервер ако не работи. Кажува од кога се податоците.'
           When = 'Кога нема Интернет, или за да погледнеш без да допреш ништо.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB - Osvezi kopija'; Script = 'mirror-refresh.ps1'; Args = ''; Icon = 'shell32.dll,238'
           NeedsEnv = 'MTB_MIRROR_READER_DATABASE_URL'
           Description = 'MTB - compare the local read-only copy with the cloud, then refresh it'; Glyph = 0xE72C; Color = '#8E44AD'; CardColor = '#8E44AD'
           Title = 'Освежи ја копијата'
           Text = 'Кажува дали копијата е иста со облакот, или колку се разликува. Прашува „DA“ пред да ја замени. Ништо не се праќа во облакот.'
           When = 'Кога сакаш копијата да е свежа — на пример пред да останеш без Интернет.' },
        @{ Tab = 'parked'; Group = 'parked'; Name = 'MTB Server - Stop'; Script = 'server-control.ps1'; Args = 'stop -Wait'; Icon = 'shell32.dll,109'
           Description = 'Therapy server - stop'; Glyph = 0xE71A; Color = '#D64545'; CardColor = '#D64545'
           Title = 'Исклучи сервер'
           Text = 'Само го гаси серверот — БЕЗ резерва. Апликациите во прелистувачот работат и потоа, само не се зачувуваат на серверот.'
           When = 'Кога нешто се поправа.'
           Confirm = 'Да го исклучам серверот, без резерва?' },
        @{ Group = 'careful'; Name = 'MTB - Oblak migracii'; Script = 'cloud-migrate.ps1'; Args = ''; Icon = 'shell32.dll,13'
           Description = 'MTB - cloud (Supabase): backup, then the pending migrations'; Glyph = 0xE753; Color = '#E0A21B'; CardColor = '#E0A21B'
           Title = 'Миграции во облакот'
           Text = 'Резерва на облачната база во backups\, па миграциите што облакот уште ги нема. Прашува „DA“ пред да смени нешто. Не е deploy на кодот — тоа е Render → Manual Deploy.'
           When = 'Само сопственикот: резерва кај себе пред надградба на облакот.' },
        @{ Group = 'careful'; Name = 'MTB - Oblak chistenje'; Script = 'cloud-cleanup.ps1'; Args = ''; Icon = 'shell32.dll,31'
           Description = 'MTB - cloud (Supabase): archive the old recovery copies here, then remove them there'; Glyph = 0xE74D; Color = '#E0752D'; CardColor = '#E0752D'
           Title = 'Чистење на облакот'
           Text = 'Ги остава последните 3 recovery копии. Постарите ги презема во backups\, ги враќа и споредува локално, и дури тогаш ги брише во облакот. Прашува „DA“.'
           When = 'Само сопственикот, ретко — кога ќе се насоберат.' },
        # The cloud server's settings page in Render. Its address names the
        # service, so like the work space's it lives in server\.env, not here.
        @{ Group = 'careful'; Name = 'Render - postavki'; UrlKey = 'MTB_RENDER_URL'; Glyph = 0xE713; Color = '#3C3C3C'; CardColor = '#111111'
           UrlPrompt = 'Адресата на страницата со поставки (Environment) на облачниот сервер во Render, на пример https://dashboard.render.com/web/…/env'
           Title = 'Render — поставки'
           Text = 'Ја отвора страницата Environment на облачниот сервер во Render: адресите и клучевите на облакот. Секоја промена таму го рестартира серверот. Тука е и Manual Deploy.'
           When = 'Само сопственикот, кога треба да се смени поставка на облакот.' },

        # ── Евиденција: one record page each, in the cloud's work space, where
        # the day's work is written. The same address as the first tile above,
        # with the window named. The six are the work space's own tabs, in its
        # order, under the apps' one name (app-names.test.ts) — and six fill two
        # rows, where the owner's four left a row of one.
        @{ Tab = 'records'; Group = 'day'; Fav = $true; Name = 'Oblak - S-Dnevnik'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=S-Dnevnik.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\s-dnevnik.jpg'; Glyph = 0xE82D; Color = '#0C8CE9'; CardColor = '#0C8CE9'
           Title = 'S-Дневник'
           Text = 'Дневникот: неделниот распоред, присуство, планови и досиеја. Се отвора во работниот простор во облакот.'
           When = 'Секој ден, на час.' },
        @{ Tab = 'records'; Group = 'day'; Fav = $true; Name = 'Oblak - Kabineti'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=RasporediFusion.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\kabineti.jpg'; Glyph = 0xE787; Color = '#1F5FD1'; CardColor = '#1F5FD1'
           Title = 'Кабинети'
           Text = 'Кој ученик кај кој терапевт и во кој термин: неделниот план на кабинетите. Во работниот простор во облакот.'
           When = 'Кога се менува распоредот на термините.' },
        @{ Tab = 'records'; Group = 'day'; Fav = $true; Name = 'Oblak - Nastava'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=Nastava.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\nastava.jpg'; Glyph = 0xE7BE; Color = '#0097A7'; CardColor = '#0097A7'
           Title = 'Настава ↔ терапии'
           Text = 'Кој ученик недостига од кој час поради терапија, по паралелка и по наставник. Во работниот простор во облакот.'
           When = 'Кога се усогласуваат наставата и терапиите.' },
        @{ Tab = 'records'; Group = 'day'; Name = 'Oblak - Uredi nastava'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=NastavaUredi.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\uredi-nastava.jpg'; Glyph = 0xE70F; Color = '#1E9E8B'; CardColor = '#1E9E8B'
           Title = 'Уреди настава'
           Text = 'Училишниот распоред на часови, час по час: по одделение, по наставник, паралелки и ѕвона. Во работниот простор во облакот.'
           When = 'Кога се внесува или менува распоредот на часови.' },
        @{ Tab = 'records'; Group = 'day'; Fav = $true; Name = 'Oblak - Spisoci i pristap'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=Podatoci.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\spisoci.jpg'; Glyph = 0xE716; Color = '#6B4FD8'; CardColor = '#6B4FD8'
           Title = 'Списоци и пристап'
           Text = 'Годишните списоци — ученици, наставници, терапевти, одделенија — и кој како влегува во Колега. Во работниот простор во облакот.'
           When = 'Кога се менува список или пристап.' },
        @{ Tab = 'records'; Group = 'day'; Name = 'Oblak - Evidenten list'; UrlKey = 'MTB_CLOUD_URL'; Page = 'MTB-Workspace.html?app=AkciskiPlan.html'
           UrlPrompt = $cloudPrompt; Thumb = 'scripts\tiles\evidenten-list.jpg'; Glyph = 0xE8A5; Color = '#2E9B4F'; CardColor = '#2E9B4F'
           Title = 'Евидентен лист'
           Text = 'Пропишаниот лист за развојот на ученикот и кварталниот план, по секции и периоди — го пополнува целиот тим. Во работниот простор во облакот.'
           When = 'Кога се пополнува или печати лист за ученик.' },

        # ── Вежби: three pages of this folder that need no server and keep no
        # records. Opened from this computer, so a lesson does not wait for the
        # Internet or for the cloud to wake. Online they are the same files.
        # All three open the ONE exercise page, each on its own part (owner,
        # 8 Oct 2026: „navigate freely in and out and from one to another"):
        # opened alone, the two tools were dead ends with no way to the others.
        @{ Tab = 'practice'; Group = 'often'; Fav = $true; Name = 'Vezbi za izgovor'; File = 'vezbi\index.html'; Part = 'vezbi'
           Thumb = 'vezbi\vezbi.jpg'; Glyph = 0xE720; Color = '#2F6FE4'; CardColor = '#2F6FE4'
           Title = 'Вежби за изговор'
           Text = '26 гласови: слогови, зборови со слики и реченици. Помошта се намалува чекор по чекор, а буквите се влечат во кутиите. Лентата горе води до двете алатки десно и до S-Дневник.'
           When = 'На час, со дете.' },
        @{ Tab = 'practice'; Group = 'often'; Fav = $true; Name = 'WBACC Unified Studio'; File = 'vezbi\index.html'; Part = 'tabla'
           Thumb = 'vezbi\tabla.jpg'; Glyph = 0xE8B9; Color = '#1E9E8B'; CardColor = '#1E9E8B'
           Title = 'WBACC Unified Studio'
           Text = 'ComuniBoard: картички со пиктограми и кирилична табла — слободно место за букви, слики и линии. Во иста лента со вежбите и со WBACC Studio.'
           When = 'Кога сама составуваш вежба.' },
        @{ Tab = 'practice'; Group = 'often'; Name = 'WBACC Studio'; File = 'vezbi\index.html'; Part = 'crtanje'
           Thumb = 'vezbi\crtanje.jpg'; Glyph = 0xE70F; Color = '#6B4FD8'; CardColor = '#6B4FD8'
           Title = 'WBACC Studio'
           Text = 'Бела табла за цртање и пишување со рака, со пиктограми (Excalidraw). Во иста лента со вежбите и со ComuniBoard.'
           When = 'За слободно цртање и за презентација.' }
    )
}

# The one shortcut that is not a tile: it opens the tiles.
function Get-MtbLauncherShortcut {
    @{ Name = 'MTB - Kontrolna tabla'; Script = 'mtb-launcher.ps1'; Args = ''; Icon = 'shell32.dll,21'
       Description = 'MTB - every action as a tile, with what it does'; Minimised = $true }
}
