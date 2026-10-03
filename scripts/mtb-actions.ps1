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
#   Title/Text/When   what a person reads on the tile and in PROCITAJ
#   Confirm      asked before the tile runs it; the shortcut itself never asks

function Get-MtbActionGroups {
    @(
        @{ Key = 'day';    Title = 'Секој ден, и по потреба' },
        @{ Key = 'cloud';  Title = 'Облак (Supabase) — само сопственикот' },
        @{ Key = 'repair'; Title = 'За поправки — прават само една работа' }
    )
}

function Get-MtbActions {
    @(
        @{ Group = 'day'; Name = 'MTB'; Script = 'mtb.ps1'; Args = ''; Icon = 'shell32.dll,44'
           Description = 'MTB - open the day'; Glyph = 0xE80F; Color = '#2F6FE4'
           Title = 'Отвори го денот'
           Text = 'Влече нов код, прави резерва па ја ажурира базата, го вклучува серверот, ја проверува машината и го отвора S-Дневник. Ако нешто не е во ред, застанува пред да ги отвори апликациите и кажува зошто.'
           When = 'Секое утро.' },
        @{ Group = 'day'; Name = 'MTB - Zavrshi den'; Script = 'mtb.ps1'; Args = '-Action stop'; Icon = 'shell32.dll,46'
           Description = 'MTB - backup, publish to pCloud, stop the server'; Glyph = 0xE708; Color = '#6B4FD8'
           Title = 'Заврши го денот'
           Text = 'Резерва на локалната база, снимка во pCloud, па го гаси серверот. Секој чекор се обидува и кога претходниот не успеал, и на крај кажува што не поминало.'
           When = 'На крај од работниот ден.'
           Confirm = 'Да го затворам денот? Ќе направам резерва и снимка во pCloud, па ќе го исклучам серверот.' },
        @{ Group = 'day'; Name = 'MTB - Azuriraj'; Script = 'mtb.ps1'; Args = '-Action update'; Icon = 'shell32.dll,238'
           Description = 'MTB - pull the code, backup, migrations, restart'; Glyph = 0xE895; Color = '#1E9E8B'
           Title = 'Ажурирај среде ден'
           Text = 'Истото ажурирање како утринското — код, пакети, резерва па миграции, рестарт на серверот — без да ги отвора апликациите.'
           When = 'Кога е пуштена промена од другиот компјутер.' },
        @{ Group = 'cloud'; Name = 'MTB - Oblak migracii'; Script = 'cloud-migrate.ps1'; Args = ''; Icon = 'shell32.dll,13'
           Description = 'MTB - cloud (Supabase): backup, then the pending migrations'; Glyph = 0xE753; Color = '#0C8CE9'
           Title = 'Миграции во облакот'
           Text = 'Резерва на облачната база во backups\, па миграциите што облакот уште ги нема. Прашува „DA“ пред да смени нешто. Не е deploy на кодот — тоа е Render → Manual Deploy.'
           When = 'Кога сакаш резерва кај себе пред надградба на облакот.' },
        @{ Group = 'cloud'; Name = 'MTB - Oblak chistenje'; Script = 'cloud-cleanup.ps1'; Args = ''; Icon = 'shell32.dll,31'
           Description = 'MTB - cloud (Supabase): archive the old recovery copies here, then remove them there'; Glyph = 0xE74D; Color = '#E0752D'
           Title = 'Чистење на облакот'
           Text = 'Ги остава последните 3 recovery копии. Постарите ги презема во backups\, ги враќа и споредува локално, и дури тогаш ги брише во облакот. Прашува „DA“.'
           When = 'Ретко — кога ќе се насоберат.' },
        @{ Group = 'repair'; Name = 'MTB Server - Start'; Script = 'server-control.ps1'; Args = 'start -Wait'; Icon = 'shell32.dll,137'
           Description = 'Therapy server - start'; Glyph = 0xE768; Color = '#2E9B4F'
           Title = 'Вклучи сервер'
           Text = 'Само го вклучува серверот и чека да одговори. Без ажурирање, без отворање на апликациите.'
           When = 'Кога нешто се поправа. Секојдневно е „Отвори го денот“.' },
        @{ Group = 'repair'; Name = 'MTB Server - Stop'; Script = 'server-control.ps1'; Args = 'stop -Wait'; Icon = 'shell32.dll,109'
           Description = 'Therapy server - stop'; Glyph = 0xE71A; Color = '#D64545'
           Title = 'Исклучи сервер'
           Text = 'Само го гаси серверот — БЕЗ резерва. Апликациите во прелистувачот работат и потоа, само не се зачувуваат на серверот.'
           When = 'Кога нешто се поправа. За крај на денот е „Заврши го денот“.'
           Confirm = 'Да го исклучам серверот, без резерва?' },
        @{ Group = 'repair'; Name = 'MTB Server - Status'; Script = 'server-control.ps1'; Args = 'status -Wait'; Icon = 'shell32.dll,23'
           Description = 'Therapy server - status'; Glyph = 0xE9D9; Color = '#5B6B82'
           Title = 'Состојба на серверот'
           Text = 'Дали серверот работи, на која адреса и со која база.'
           When = 'Кога не си сигурен дали е вклучен.' }
    )
}

# The one shortcut that is not a tile: it opens the tiles.
function Get-MtbLauncherShortcut {
    @{ Name = 'MTB - Kontrolna tabla'; Script = 'mtb-launcher.ps1'; Args = ''; Icon = 'shell32.dll,21'
       Description = 'MTB - every action as a tile, with what it does'; Minimised = $true }
}
