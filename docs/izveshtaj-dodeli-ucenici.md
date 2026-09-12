# Извештај: Функции за „Додели ученици“ и листата на екстерни ученици

**Датум:** 2026-09-11  
**Репозиториум:** `C:\Users\Admin\Documents\GitHub\MTB`  
**База:** `therapy_dev` (PostgreSQL 18)  
**Учебна година:** 2026/2027 (тековна)

---

## 1. Забелешка за миграција 028 и податоците

> [!NOTE]
> **Исправка:** Миграцијата `028_kind_matches_grade.sql` содржи исклучиво `CHECK` ограничување (`ADD CONSTRAINT kind_matches_grade CHECK (...)`) и **не извршува ниту еден `UPDATE`, `INSERT` или `DELETE`**.
> Вредностите `grade = NULL` за 16-те екстерни ученици постоеле во базата од претходно. Миграцијата 028 само гарантира на ниво на база дека активен екстерен ученик не смее да има одделение отсега натаму.

### Состојба во `therapy_dev` за 2026/2027:
- Вкупно активни ученици: **78**
  - `internal`: 46 (сите имаат пополнето `grade`)
  - `boarding`: 16 (сите имаат пополнето `grade`)
  - `external`: 16 (сите имаат `grade = NULL`)

---

## 2. Упитот за задолженија на терапевтите (`roster.therapists[i].students`)

**Датотека:** [`server/src/routes/data.ts`](../server/src/routes/data.ts) (линии 137–150):

```typescript
pool.query(
    `SELECT t.id, t.name,
            coalesce(array_agg(DISTINCT s.public_id ORDER BY s.public_id)
                     FILTER (WHERE se.student_id IS NOT NULL), '{}') AS students,
            count(DISTINCT sl.id)::int AS terms_per_week
     FROM therapists t
     JOIN therapist_years thy ON thy.therapist_id = t.id AND thy.school_year_id = $1 AND thy.active
     LEFT JOIN therapist_students ts ON ts.therapist_id = t.id AND ts.school_year_id = $1
     LEFT JOIN students s ON s.id = ts.student_id AND (s.active OR NOT $2::boolean)
     LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_year_id = $1 AND se.active
     LEFT JOIN schedule_slots sl ON sl.therapist_id = t.id AND sl.school_year_id = $1
     GROUP BY t.id ORDER BY t.name`,
    [year.id, year.is_current]
)
```

**Анализа на упитот:**
- Во овој упит **нема** спојување со `school_classes` ниту по `grade`.
- Сите спојувања со задолженијата и записите (`therapist_students`, `students`, `student_enrollments`, `schedule_slots`) се `LEFT JOIN`.
- `FILTER (WHERE se.student_id IS NOT NULL)` само проверува дали ученикот има активен запис во `student_enrollments` за таа година.

---

## 3. Функција `openCaseload(id)` во `Podatoci.html`

**Датотека:** [`Podatoci.html`](../Podatoci.html) (линии 1300–1322):

```javascript
    function openCaseload(id) {
        const therapist = (data.therapists || []).find((t) => t.id === id);
        if (!therapist) return;
        const mine = new Set(therapist.students || []);
        const box = el('studentPicker');
        box.className = 'picker open';
        const active = (data.students || []).filter((s) => s.active);
        box.innerHTML =
            `<h3>Ученици кај ${esc(personName(therapist.name))} <span class="none">· ${esc(data.year)}</span></h3>`
            + (active.length
                ? '<div class="grid-pick">'
                  + active.map((s, index) =>
                      `<label><input type="checkbox" value="${esc(s.public_id)}"${mine.has(s.public_id) ? ' checked' : ''}>`
                      + `<span><span class="list-number">${index + 1}.</span>${esc(personName(s.name))}${s.grade ? ' · ' + esc(s.grade) : ''}</span></label>`).join('')
                  + '</div>'
                : '<p class="hint">Нема запишани ученици за оваа година.</p>')
            + '<div class="controls" style="margin-top:12px;">'
            + `<button class="btn" data-save-caseload="${id}">Зачувај список</button>`
            + '<button class="btn soft" data-close-picker>Откажи</button></div>';
        box.querySelector('[data-save-caseload]').addEventListener('click', () => saveCaseload(id));
        box.querySelector('[data-close-picker]').addEventListener('click', closePickers);
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
```

---

## 4. Функциите `openCaseloadModal()` и `renderCaseloadGrid()` во `RasporediFusion.html`

**Датотека:** [`RasporediFusion.html`](../RasporediFusion.html) (линии 1445–1494):

```javascript
    function openCaseloadModal() {
        const therapists = (state.roster && state.roster.therapists) || [];
        const therapist = therapists.find((t) => String(t.id) === String(state.rosterTherapist)) || therapists[0];
        if (!therapist) return showNotice('Избери терапевт прво.', 'warn');
        if (!mayEditTherapist(therapist.id)) {
            return showNotice('Може да го менувате само сопствениот список на ученици.', 'error');
        }

        // /api/roster is already scoped to the selected year.  A present-day
        // global active flag must not hide a pupil from an archived roster.
        const activeStudents = ((state.roster && state.roster.students) || []);
        activeCaseloadAssigned = new Set(therapist.students || []);

        el('caseloadModalTitle').textContent = 'Ученици кај ' + therapist.name + ' · ' + state.year;
        el('caseloadSearch').value = '';
        renderCaseloadGrid(activeStudents, '');
        el('caseloadModal').hidden = false;
        el('caseloadSearch').focus();
    }

    function renderCaseloadGrid(activeStudents, query) {
        const q = query.trim().toLocaleLowerCase('mk');
        const filtered = activeStudents.filter((s) => !q || (s.name + ' ' + (s.grade || '')).toLocaleLowerCase('mk').includes(q));

        if (!filtered.length) {
            el('caseloadGrid').innerHTML = '<p style="color:var(--muted);margin:14px 0;">Нема ученици за избраниот филтер.</p>';
            updateCaseloadCount();
            return;
        }

        el('caseloadGrid').innerHTML = filtered.map((student, idx) => {
            const checked = activeCaseloadAssigned.has(student.public_id);
            return '<label class="caseload-item" data-id="' + esc(student.public_id) + '">' +
                '<input type="checkbox" value="' + esc(student.public_id) + '"' + (checked ? ' checked' : '') + '>' +
                '<span><span class="list-number">' + (idx + 1) + '.</span>' + esc(student.name) +
                (student.grade ? ' · ' + esc(student.grade) : '') +
                (student.kind && student.kind !== 'internal' ? ' (' + (student.kind === 'boarding' ? 'инт.' : 'екст.') + ')' : '') +
                '</span></label>';
        }).join('');

        updateCaseloadCount();

        el('caseloadGrid').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', (e) => {
                if (e.target.checked) activeCaseloadAssigned.add(e.target.value);
                else activeCaseloadAssigned.delete(e.target.value);
                updateCaseloadCount();
            });
        });
    }
```
