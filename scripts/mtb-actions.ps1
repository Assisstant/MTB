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
#                key set. The read-only copy of the cloud is set up on HOME and
#                not on WORK (owner, 7 Oct 2026), and a tile for something this
#                computer does not have is a tile that fails. Where the key is
#                missing there is no tile, no .lnk and no PROCITAJ line.

# The order and the colours carry the logic (owner, 3 Oct 2026: „by kinship,
# by some logic — importance, order"). Three groups of three, one row each in
# the panel, from the most used to the one that needs care:
#   day      blue    the day's work, most important;
#   often    green   now and then, safe — nothing is stopped or changed;
#   careful  warm    stops or changes something, and asks first.
# Within a group each tile has its own shade of the family, so a row reads
# as one kind of thing and each tile can still be told apart.
function Get-MtbActionGroups {
    @(
        # Title heads a section of PROCITAJ; Word is the same on a tile, which has no sections.
        @{ Key = 'day';     Title = 'Секој ден — најважните';                      Word = 'секој ден' },
        @{ Key = 'often';   Title = 'По потреба — безбедни, ништо не гасат';       Word = 'по потреба' },
        @{ Key = 'careful'; Title = 'Внимателно — гасат или менуваат, прашуваат'; Word = 'внимателно' }
    )
}

function Test-MtbEnvKey([string] $Key) {
    $file = Join-Path (Split-Path -Parent $PSScriptRoot) 'server\.env'
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    return [bool](Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=\s*\S" } | Select-Object -First 1)
}

# What THIS computer offers: the whole list, less what it is not set up for.
function Get-MtbActions {
    @(Get-MtbAllActions | Where-Object { -not $_.NeedsEnv -or (Test-MtbEnvKey $_.NeedsEnv) })
}

function Get-MtbAllActions {
    @(
        # Daily work is written in the cloud (23 Sep 2026), so it comes first. A
        # tile only, no .lnk: it opens the browser, not a script. Its address is
        # MTB_CLOUD_URL in server\.env — the cloud's address is not written in
        # this public repository — and the tile asks for it once if it is not there.
        @{ Group = 'day'; Name = 'Oblak - rabotna povrshina'; UrlKey = 'MTB_CLOUD_URL'; Glyph = 0xE774; Color = '#1F5FD1'; CardColor = '#1F5FD1'
           UrlPrompt = 'Адресата на облачниот работен простор, на пример https://…/MTB-Workspace.html'
           Title = 'Облак — работен простор'
           Text = 'Го отвора MTB работниот простор во облакот (Render), во прелистувачот. Таму се работи секој ден; локалната база е резервен режим кога нема Интернет.'
           When = 'Секој ден, за работа.' },
        @{ Group = 'day'; Name = 'MTB'; Script = 'mtb.ps1'; Args = ''; Icon = 'shell32.dll,44'
           Description = 'MTB - open the day'; Glyph = 0xE80F; Color = '#0C8CE9'; CardColor = '#0C8CE9'
           Title = 'Отвори го денот'
           Text = 'Влече нов код, прави резерва па ја ажурира базата, го вклучува серверот, ја проверува машината и го отвора S-Дневник. Ако нешто не е во ред, застанува пред да ги отвори апликациите и кажува зошто.'
           When = 'Секое утро.' },
        @{ Group = 'day'; Name = 'MTB - Zavrshi den'; Script = 'mtb.ps1'; Args = '-Action stop'; Icon = 'shell32.dll,46'
           Description = 'MTB - backup, publish to pCloud, stop the server'; Glyph = 0xE708; Color = '#6B4FD8'; CardColor = '#6B4FD8'
           Title = 'Заврши го денот'
           Text = 'Резерва на локалната база, снимка во pCloud, па го гаси серверот. Секој чекор се обидува и кога претходниот не успеал, и на крај кажува што не поминало.'
           When = 'На крај од работниот ден.'
           Confirm = 'Да го затворам денот? Ќе направам резерва и снимка во pCloud, па ќе го исклучам серверот.' },
        @{ Group = 'often'; Name = 'MTB - Azuriraj'; Script = 'mtb.ps1'; Args = '-Action update'; Icon = 'shell32.dll,238'
           Description = 'MTB - pull the code, backup, migrations, restart'; Glyph = 0xE895; Color = '#1E9E8B'; CardColor = '#1E9E8B'
           Title = 'Ажурирај среде ден'
           Text = 'Истото ажурирање како утринското — код, пакети, резерва па миграции, рестарт на серверот — без да ги отвора апликациите.'
           When = 'Кога е пуштена промена од другиот компјутер.' },
        @{ Group = 'often'; Name = 'MTB Server - Status'; Script = 'server-control.ps1'; Args = 'status -Wait'; Icon = 'shell32.dll,23'
           Description = 'Therapy server - status'; Glyph = 0xE9D9; Color = '#0097A7'; CardColor = '#0097A7'
           Title = 'Состојба на серверот'
           Text = 'Дали серверот работи, на која адреса и со која база. Само кажува, ништо не менува.'
           When = 'Кога не си сигурен дали е вклучен.' },
        @{ Group = 'often'; Name = 'MTB Server - Start'; Script = 'server-control.ps1'; Args = 'start -Wait'; Icon = 'shell32.dll,137'
           Description = 'Therapy server - start'; Glyph = 0xE768; Color = '#2E9B4F'; CardColor = '#2E9B4F'
           Title = 'Вклучи сервер'
           Text = 'Само го вклучува серверот и чека да одговори. Без ажурирање, без отворање на апликациите.'
           When = 'Кога нешто се поправа. Секојдневно е „Отвори го денот“.' },
        # The read-only copy of the cloud (docs\SUPABASE-MIRROR.md): only where it is set up.
        @{ Group = 'often'; Name = 'MTB - Kopija od oblakot'; Script = 'mirror-open.ps1'; Args = ''; Icon = 'shell32.dll,22'
           NeedsEnv = 'MTB_MIRROR_READER_DATABASE_URL'
           Description = 'MTB - open the read-only copy of the cloud'; Glyph = 0xE8A7; Color = '#5B6B82'; CardColor = '#5B6B82'
           Title = 'Копија од облакот'
           Text = 'Ја отвора копијата од облакот, само за читање, и го вклучува нејзиниот сервер ако не работи. Кажува од кога се податоците.'
           When = 'Кога нема Интернет, или за да погледнеш без да допреш ништо.' },
        @{ Group = 'careful'; Name = 'MTB - Osvezi kopija'; Script = 'mirror-refresh.ps1'; Args = ''; Icon = 'shell32.dll,238'
           NeedsEnv = 'MTB_MIRROR_READER_DATABASE_URL'
           Description = 'MTB - compare the local read-only copy with the cloud, then refresh it'; Glyph = 0xE72C; Color = '#8E44AD'; CardColor = '#8E44AD'
           Title = 'Освежи ја копијата'
           Text = 'Кажува дали копијата е иста со облакот, или колку се разликува. Прашува „DA“ пред да ја замени. Ништо не се праќа во облакот.'
           When = 'Кога сакаш копијата да е свежа — на пример пред да останеш без Интернет.' },
        @{ Group = 'careful'; Name = 'MTB Server - Stop'; Script = 'server-control.ps1'; Args = 'stop -Wait'; Icon = 'shell32.dll,109'
           Description = 'Therapy server - stop'; Glyph = 0xE71A; Color = '#D64545'; CardColor = '#D64545'
           Title = 'Исклучи сервер'
           Text = 'Само го гаси серверот — БЕЗ резерва. Апликациите во прелистувачот работат и потоа, само не се зачувуваат на серверот.'
           When = 'Кога нешто се поправа. За крај на денот е „Заврши го денот“.'
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
           When = 'Само сопственикот, кога треба да се смени поставка на облакот.' }
    )
}

# The one shortcut that is not a tile: it opens the tiles.
function Get-MtbLauncherShortcut {
    @{ Name = 'MTB - Kontrolna tabla'; Script = 'mtb-launcher.ps1'; Args = ''; Icon = 'shell32.dll,21'
       Description = 'MTB - every action as a tile, with what it does'; Minimised = $true }
}
