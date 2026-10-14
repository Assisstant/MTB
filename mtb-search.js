/*
 * „🔍 Барај" во работниот простор (сопственикот, 14 октомври 2026): еден збор
 * — „превоз", „лозинка", „аудиограм" — води до местото каде што е таа опција,
 * низ сите апликации. Само за администраторот: Колега го нема.
 *
 * DESTINATIONS е единствениот список. Секоја ставка има наслов, патека (што
 * се гледа) и зборови: тоа што луѓето навистина го кажуваат, не само називот
 * на копчето. Нов збор се додава во `words` на ставката; нова ставка — во
 * списокот, со `go`:
 *   { app: 'Podatoci.html', view: { tab: 'colleagues' } }  прозорец и неговиот поглед
 *   { admin: 'employees' }                                  „Администрација" и нејзиниот дел
 *   { page: 'Obelezuvaci.html', name: 'mtb-obelezuvaci' }   своја страница, во свое јазиче
 * Погледот го разбира самата апликација (app-navigation.js `views`, или
 * нејзиниот слушател за `mtb:open-view`); непознат поглед ја отвора само апликацијата.
 *
 * Барањето не прави разлика меѓу кирилица и латиница („prevoz" = „превоз"),
 * ниту меѓу големи и мали букви.
 */
(function () {
    'use strict';

    const DESTINATIONS = [
        // ── Кабинети ─────────────────────────────────────────────────────
        { title: 'Термини', path: 'Кабинети → Термини', go: { app: 'RasporediFusion.html', view: { panel: 'schedule' } },
            words: ['распоред кабинети', 'термин', 'закажи', 'кабинет', 'терапија', 'час кај терапевт', 'групен термин'] },
        { title: 'Ученици по терапевт', path: 'Кабинети → Ученици по терапевт', go: { app: 'RasporediFusion.html', view: { panel: 'roster' } },
            words: ['листа на терапевт', 'мои ученици', 'кој кај кого', 'додели ученик', 'caseload', 'список терапевт'] },
        { title: 'Сега', path: 'Кабинети → 🔔 Сега', go: { app: 'RasporediFusion.html', view: { panel: 'now' } },
            words: ['сега', 'тековен час', 'кој е каде', 'денес', 'во моментов'] },
        { title: 'Посети по ученик', path: 'Кабинети → Посети по ученик', go: { app: 'RasporediFusion.html', view: { panel: 'visits' } },
            words: ['посети', 'колку кабинети', 'кабинети на дете', 'ученик посетува'] },
        { title: 'Списоци за печатење', path: 'Кабинети → Списоци за печатење', go: { app: 'RasporediFusion.html', view: { panel: 'lists' } },
            words: ['печати список', 'листи', 'печатење кабинети'] },

        // ── Настава ↔ терапии ────────────────────────────────────────────
        { title: 'Паралелка · недела', path: 'Настава ↔ терапии → 🏫 Паралелка · недела', go: { app: 'Nastava.html', view: { view: 'classweek' } },
            words: ['пропушта час', 'отсуство од час', 'кој пропушта', 'паралелка недела', 'одделение недела'] },
        { title: 'Наставник · недела', path: 'Настава ↔ терапии → 👤 Наставник · недела', go: { app: 'Nastava.html', view: { view: 'personal' } },
            words: ['наставник недела', 'распоред наставник', 'кој ученик излегува'] },
        { title: 'Преглед · недела', path: 'Настава ↔ терапии → 📊 Преглед · недела', go: { app: 'Nastava.html', view: { view: 'week' } },
            words: ['преглед недела', 'сите паралелки', 'збир терапии'] },

        // ── Уреди настава ────────────────────────────────────────────────
        { title: 'Распоред по одделение · еден ден', path: 'Уреди настава → 🏫 По одделение · еден ден', go: { app: 'NastavaUredi.html', view: { view: 'class' } },
            words: ['распоред на часови', 'уреди час', 'настава распоред', 'предмет во час'] },
        { title: 'Одделение · цела недела', path: 'Уреди настава → 📅 Одделение · цела недела', go: { app: 'NastavaUredi.html', view: { view: 'classweek' } },
            words: ['неделен распоред одделение', 'распоред паралелка'] },
        { title: 'Наставник · цела недела', path: 'Уреди настава → 👩‍🏫 Наставник · цела недела', go: { app: 'NastavaUredi.html', view: { view: 'teacher' } },
            words: ['норма', 'часови на наставник', 'распоред наставник уреди'] },
        { title: 'Распределба', path: 'Уреди настава → 🔗 Распределба', go: { app: 'NastavaUredi.html', view: { view: 'assign' } },
            words: ['кој предава каде', 'наставник паралелка', 'распределба часови', 'предмети по наставник'] },

        // ── Списоци и пристап ────────────────────────────────────────────
        { title: 'Ученици', path: 'Списоци и пристап → 🎒 Ученици', go: { app: 'Podatoci.html', view: { tab: 'students' } },
            words: ['нов ученик', 'додај ученик', 'упис', 'листа ученици', 'интерен', 'екстерен', 'надворешен', 'подготвителна', 'годишен список'] },
        { title: 'Наставници', path: 'Списоци и пристап → 👩‍🏫 Наставници', go: { app: 'Podatoci.html', view: { tab: 'teachers' } },
            words: ['нов наставник', 'листа наставници', 'одделенски', 'предметен'] },
        { title: 'Терапевти', path: 'Списоци и пристап → 🧩 Терапевти', go: { app: 'Podatoci.html', view: { tab: 'therapists' } },
            words: ['терапевт', 'кабинети листа', 'профил кабинет', 'категорија', 'логопед', 'психолог', 'дефектолог'] },
        { title: 'Одделенија', path: 'Списоци и пристап → 🏫 Одделенија', go: { app: 'Podatoci.html', view: { tab: 'classes' } },
            words: ['паралелка', 'одделение', 'раководител', 'класен', 'нова паралелка'] },
        { title: 'Предмети', path: 'Списоци и пристап → 📚 Предмети', go: { app: 'Podatoci.html', view: { tab: 'subjects' } },
            words: ['предмет', 'нов предмет', 'наставен предмет'] },
        { title: 'Распоред (наставник)', path: 'Списоци и пристап → 🗓️ Распоред', go: { app: 'Podatoci.html', view: { tab: 'week' } },
            words: ['неделен распоред наставник', 'седмица наставник'] },
        { title: 'Колеги — сметки и пристап', path: 'Списоци и пристап → 👥 Колеги', go: { app: 'Podatoci.html', view: { tab: 'colleagues' } },
            words: ['лозинка', 'почетна лозинка', 'сметка', 'најава колеги', 'линк колеги', 'пристап', 'корисничко име', 'отвори го формуларот',
                'само преглед', 'престој вработен', 'нов вработен престој', 'промени од колегите', 'врати промена', 'промени во акциски план', 'дежурства админ'] },
        { title: 'Формулари', path: 'Списоци и пристап → 📥 Формулари', go: { app: 'Podatoci.html', view: { tab: 'forms' } },
            words: ['формулар', 'одговори', 'google form', 'анкета'] },
        { title: 'Безбедност', path: 'Списоци и пристап → 🔐 Безбедност', go: { app: 'Podatoci.html', view: { tab: 'security' } },
            words: ['заклучи', 'одржување', 'кодиран линк', 'тестери', 'затвори ја вратата', 'моја сметка'] },
        { title: 'Изглед', path: 'Списоци и пристап → 🎨 Изглед', go: { app: 'Podatoci.html', view: { tab: 'look' } },
            words: ['тема', 'бои', 'изглед'] },

        // ── Администрација ───────────────────────────────────────────────
        { title: 'Администрација — Ученици', path: 'Администрација → Ученици', go: { admin: 'pupils' },
            words: ['годишни податоци ученик', 'статус ученик', 'програма', 'модифицирана', 'интернат', 'активен неактивен'] },
        { title: 'Администрација — Вработени', path: 'Администрација → Вработени', go: { admin: 'employees' },
            words: ['вработен', 'годишна улога', 'улога престој', 'професија', 'задолженија', 'нов вработен', 'администрација вработени'] },

        // ── Евидентен лист ───────────────────────────────────────────────
        { title: 'Евидентен лист — Профил', path: 'Евидентен лист → 👤 Профил', go: { app: 'AkciskiPlan.html', view: { tab: 'pProfile' } },
            words: ['евидентен лист', 'профил ученик', 'дијагноза', 'наод и мислење'] },
        { title: 'Евидентен лист — Проценка', path: 'Евидентен лист → 📊 Проценка', go: { app: 'AkciskiPlan.html', view: { tab: 'pScores' } },
            words: ['оценки евидентен', 'почеток полугодие крај', 'општа проценка'] },
        { title: 'Евидентен лист — Сетила и говор', path: 'Евидентен лист → 👁 Сетила и говор', go: { app: 'AkciskiPlan.html', view: { tab: 'pPanels' } },
            words: ['вид', 'слух', 'говор', 'тифлолог', 'сурдолог', 'биофидбек'] },
        { title: 'Евидентен лист — Стручни лица', path: 'Евидентен лист → 👥 Стручни лица', go: { app: 'AkciskiPlan.html', view: { tab: 'pPeople' } },
            words: ['контакти', 'испитувач', 'стручни лица'] },
        { title: 'Евидентен лист — Печатење', path: 'Евидентен лист → 🖨 Печатење', go: { app: 'AkciskiPlan.html', view: { tab: 'pPrint' } },
            words: ['печати евидентен лист', 'word евидентен'] },

        // ── S-Дневник ────────────────────────────────────────────────────
        { title: 'Дневник — Распоред и присуство', path: 'S-Дневник → Распоред', go: { app: 'S-Dnevnik.html', view: { tab: 'schedule' } },
            words: ['дневник', 'присуство дневник', 'мој распоред', 'недела дневник', 'означи присуство'] },
        { title: 'Дневник — Ученици', path: 'S-Дневник → Ученици', go: { app: 'S-Dnevnik.html', view: { tab: 'students' } },
            words: ['мои ученици дневник', 'архива ученик'] },
        { title: 'Дневник — Напредок', path: 'S-Дневник → Напредок', go: { app: 'S-Dnevnik.html', view: { tab: 'progress' } },
            words: ['напредок', 'зелени ознаки', 'постигнато'] },
        { title: 'Дневник — Планови', path: 'S-Дневник → Планови', go: { app: 'S-Dnevnik.html', view: { tab: 'plans' } },
            words: ['план', 'вежби план', 'третман план'] },
        { title: 'Дневник — Тријажни тестови', path: 'S-Дневник → Тријажни тестови', go: { app: 'S-Dnevnik.html', view: { tab: 'trijazen' } },
            words: ['тријажа', 'тријажен тест', 'гласови тест'] },
        { title: 'Дневник — Проценка', path: 'S-Дневник → 📊 Проценка', go: { app: 'S-Dnevnik.html', view: { tab: 'procenka' } },
            words: ['проценка дневник', 'тест проценка'] },
        { title: 'Дневник — Досие', path: 'S-Дневник → 📂 Досие', go: { app: 'S-Dnevnik.html', view: { tab: 'dosie' } },
            words: ['досие', 'документи ученик'] },
        { title: 'Дневник — Аудиограми', path: 'S-Дневник → Аудиограми', go: { app: 'S-Dnevnik.html', view: { tab: 'audiogramsApp' } },
            words: ['аудиограм', 'слух', 'аудиометрија'] },
        { title: 'Дневник — Генератор', path: 'S-Дневник → 📄 Генератор', go: { app: 'S-Dnevnik.html', view: { tab: 'generator' } },
            words: ['генератор', 'извештај', 'документ word', 'мислење'] },
        { title: 'Дневник — Сервер и резерви', path: 'S-Дневник → ⚙️ Сервер и резерви', go: { app: 'S-Dnevnik.html', view: { tab: 'data' } },
            words: ['резерва', 'backup', 'извоз json', 'увоз json', 'сервер', 'снимка'] },

        // ── Преглед на базата ────────────────────────────────────────────
        { title: 'Преглед на базата', path: 'Преглед на базата', go: { app: 'Pregled-Baza.html' },
            words: ['база', 'бројки', 'статистика', 'колку ученици'] },

        // ── Колега, отворен како колега (своја страница) ─────────────────
        { title: 'Надворешни ученици — превоз', path: 'Колега → ✓ Присуство → Надворешни — превоз, сите кабинети',
            go: { page: 'Kolega.html#tab=attendance&report=transport', name: 'mtb-kolega' },
            words: ['превоз', 'транспорт', 'екстерни', 'надворешни', 'доаѓања', 'потврда за превоз', 'месечно присуство екстерни', 'автобус'] },
        { title: 'Колега — Присуство', path: 'Колега → ✓ Присуство', go: { page: 'Kolega.html#tab=attendance', name: 'mtb-kolega' },
            words: ['присуство кабинет', 'месечно присуство', 'присуство паралелка', 'храна', 'присутни'] },
        { title: 'Колега — Мој кабинет', path: 'Колега → Мој кабинет', go: { page: 'Kolega.html#tab=cabinet', name: 'mtb-kolega' },
            words: ['колега', 'kolegi', 'мој кабинет', 'сите кабинети слика'] },
        { title: 'Колега — Акциски план', path: 'Колега → 📄 Акциски план', go: { page: 'Kolega.html#tab=plan', name: 'mtb-kolega' },
            words: ['акциски план', 'иоп', 'квартал', 'потврди план', 'квартален преглед'] },
        { title: 'Колега — Дежурства', path: 'Колега → Дежурства', go: { page: 'Kolega.html#tab=duty', name: 'mtb-kolega' },
            words: ['дежурство', 'дежурен', 'кој дежура', 'замена дежурство'] },

        // ── Свои страници ────────────────────────────────────────────────
        { title: 'Обележувачи', path: '🔖 Обележувачи', go: { page: 'Obelezuvaci.html', name: 'mtb-obelezuvaci' },
            words: ['линкови', 'bookmarks', 'обележувач'] },
        { title: 'Докази', path: 'Докази (ментор)', go: { page: 'Dokazi.html', name: 'mtb-dokazi' },
            words: ['ментор', 'докази', 'стандарди', 'индикатори', 'звање'] },
        { title: 'Вежби за изговор', path: 'Вежби за изговор', go: { page: 'vezbi/index.html', name: 'mtb-vezbi' },
            words: ['вежби', 'гласови', 'изговор', 'comuniboard', 'wbacc', 'печати картички'] },
        { title: 'Синхронизација', path: 'Синхронизација — каде стојат податоците', go: { page: 'Sinhronizacija.html', name: 'mtb-sinhronizacija' },
            words: ['синхронизација', 'дома работа', 'облак', 'споредба бази'] }
    ];

    // ── барањето ──────────────────────────────────────────────────────────
    const LATIN = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'g', е: 'e', ж: 'z', з: 'z', ѕ: 'dz', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'l', м: 'm',
        н: 'n', њ: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'k', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's' };
    /**
     * One spelling for every way of typing: lower case, Latin, without marks, and the
     * pairs people write for one letter made one — „ученици", „ucenici", „uchenici" and
     * „učenici" meet, as do „лозинка" and „lozinka". Only for finding; nothing is shown so.
     */
    function fold(text) {
        return String(text || '').toLocaleLowerCase('mk-MK').replace(/[а-шѓѕјљњќџ]/g, (c) => LATIN[c] || c)
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/dzh/g, 'dz').replace(/ch|sh|zh|kj|gj|lj|nj/g, (pair) => pair[0])
            .replace(/[^a-z0-9]+/g, ' ').trim();
    }
    const INDEX = DESTINATIONS.map((d) => ({ d, title: fold(d.title), path: fold(d.path), words: d.words.map(fold) }));
    /** Every word of the question must be found; a title counts most, the start of a word more than its middle. */
    function search(question) {
        const parts = fold(question).split(' ').filter(Boolean);
        if (!parts.length) return [];
        return INDEX.map((entry) => {
            let score = 0;
            for (const part of parts) {
                const starts = (text) => (' ' + text).includes(' ' + part);
                const best = starts(entry.title) ? 6 : entry.words.some(starts) ? 4 : entry.title.includes(part) ? 3
                    : entry.words.some((w) => w.includes(part)) ? 2 : entry.path.includes(part) ? 1 : 0;
                if (!best) return null;
                score += best;
            }
            return { d: entry.d, score };
        }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.d);
    }
    // Read without a page (server/test/workspace-search.test.ts checks every destination against the apps).
    if (typeof window === 'undefined' || !window.document) { globalThis.MTBSearchData = { DESTINATIONS, search, fold }; return; }

    // ── одењето ───────────────────────────────────────────────────────────
    function go(dest) {
        const g = dest.go;
        if (g.page) { window.open(g.page, g.name || '_blank'); return; }
        if (g.admin) {
            const admin = document.getElementById('masterAdmin');
            if (!admin || admin.hidden) document.getElementById('openMasterAdmin')?.click();
            setTimeout(() => document.querySelector('#masterAdmin [data-ma-tab="' + g.admin + '"]')?.click(), 0);
            return;
        }
        if (g.app && window.MTBWorkspaceOpen) window.MTBWorkspaceOpen(g.app, g.view || null);
    }

    // ── прозорецот ────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
#mtbSearch { position: fixed; inset: 0; z-index: 2000; background: rgba(10, 16, 28, .45); display: flex; align-items: flex-start; justify-content: center; padding: 10vh 16px 16px; }
#mtbSearch[hidden] { display: none; }
#mtbSearch .box { width: min(640px, 100%); background: var(--mtb-panel, var(--mtb-face, #fff)); color: var(--mtb-ink, #172139); border: 1px solid var(--mtb-line, #c5cedb);
  border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.35); overflow: hidden; }
#mtbSearch input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--mtb-line, #c5cedb); padding: 16px 18px; font: 600 17px system-ui, sans-serif;
  background: transparent; color: inherit; outline: none; }
#mtbSearch ul { list-style: none; margin: 0; padding: 6px; max-height: 56vh; overflow-y: auto; }
#mtbSearch li button { display: block; width: 100%; text-align: left; border: 0; border-radius: 10px; padding: 9px 12px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
#mtbSearch li button[aria-selected="true"], #mtbSearch li button:hover { background: var(--mtb-well, #edf2f7); }
#mtbSearch li b { display: block; font-size: 15px; }
#mtbSearch li small { display: block; font-size: 13px; opacity: .75; margin-top: 2px; }
#mtbSearch .hint { margin: 0; padding: 10px 18px 14px; font-size: 13px; opacity: .75; }
`;
    document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.id = 'mtbSearch'; overlay.hidden = true;
    overlay.innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-label="Барај опција">'
        + '<input type="search" id="mtbSearchInput" autocomplete="off" placeholder="Што барате? На пр. превоз, лозинка, аудиограм…" aria-label="Барај опција" aria-controls="mtbSearchList">'
        + '<ul id="mtbSearchList" role="listbox" aria-label="Резултати"></ul>'
        + '<p class="hint">↑ ↓ избор · Enter отвора · Esc затвора · Ctrl+K од кое било место</p></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input'), list = overlay.querySelector('ul');
    let shown = [], chosen = 0;

    function paint() {
        shown = input.value.trim() ? search(input.value) : [];
        chosen = Math.min(chosen, Math.max(0, shown.length - 1));
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        list.innerHTML = !input.value.trim() ? ''
            : shown.length ? shown.map((d, i) => `<li><button type="button" role="option" data-pick="${i}" aria-selected="${i === chosen}"><b>${esc(d.title)}</b><small>${esc(d.path)}</small></button></li>`).join('')
            : '<li class="hint">Нема ништо за тоа. Пробајте друг збор.</li>';
    }
    function open() {
        overlay.hidden = false; input.value = ''; chosen = 0; paint();
        input.focus();
    }
    function close() { overlay.hidden = true; }
    function pick(i) { const d = shown[i]; if (!d) return; close(); go(d); }

    input.addEventListener('input', () => { chosen = 0; paint(); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (shown.length) chosen = (chosen + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
            paint();
        } else if (event.key === 'Enter') { event.preventDefault(); pick(chosen); }
        else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    list.addEventListener('click', (event) => { const b = event.target.closest('[data-pick]'); if (b) pick(Number(b.dataset.pick)); });
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });

    /** Ctrl+K (⌘K) opens it — also from inside a window, which tells the workspace (wireFrame). */
    function shortcut(event) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K' || event.key === 'л' || event.key === 'Л')) {
            event.preventDefault(); overlay.hidden ? open() : close();
        }
    }
    document.addEventListener('keydown', shortcut);

    const button = document.createElement('button');
    button.type = 'button'; button.className = 'soft compact'; button.id = 'openSearch';
    button.textContent = '🔍 Барај'; button.title = 'Барај опција низ сите апликации (Ctrl+K)';
    button.addEventListener('click', open);
    const anchor = document.getElementById('openColleagues');
    if (anchor) anchor.before(button);

    window.MTBSearch = { open, close, search, shortcut, destinations: DESTINATIONS };
})();
