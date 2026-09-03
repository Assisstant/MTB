-- Евидентен лист: the pupil development record, on rows instead of in a browser.
--
-- AkciskiPlan.html kept the whole thing in one localStorage array, so the
-- record lived on whichever machine the therapist happened to open, and no two
-- specialists could fill their own section of the same child.  The form is
-- filled by many people -- дефектолог, логопед, психолог, тифлолог, сурдолог,
-- биофидбек терапевт -- and each section already names its own испитувач.
-- That is why the sheet is split into cells here: a score is (sheet, item,
-- period) and two specialists writing different sections never touch one row.
--
-- FOUR DECISIONS WORTH THE READING TIME.
--
-- 1. The CATALOGUE is data.  The sections, their items and the examiner lines
--    were a JavaScript literal, so adding one indicator meant editing the app.
--    They are tables now, and the app edits them.  An item's `ord` starts at 0
--    on purpose: it is the index the old app used in its score keys ('s6_3'),
--    so a legacy JSON export can still be read back item for item.
--
-- 2. The PERIODS belong to a school year, not to the code.  The printed form
--    has three columns; this centre fills the record four times a year.  Both
--    are true, at different times, so the columns are rows -- and an archived
--    year keeps the columns it was actually filled with.  Nothing here seeds
--    them; the API creates a year's default four on first use.
--
-- 3. The sheet does NOT own the child's class.  student_enrollments does, and
--    a second copy is the two-deciders failure this project keeps undoing.
--    Everything else on the profile (date and place of birth, the diagnosis
--    quoted from Наод и мислење, струка/занимање) is this document's own text,
--    written on a date and signed -- not a live fact about the pupil.
--
-- 4. The login is a STAFF-ROOM LOCK, not security.  Nothing else in this API
--    authenticates, the server listens on the tailnet, and a PIN typed into a
--    shared browser stops a colleague opening the wrong record -- it does not
--    stop anyone who can reach the port.  It is here because the record has to
--    say WHO wrote each line, which is what the form itself asks for.

BEGIN;

CREATE TABLE IF NOT EXISTS evidence_sections (
    id             serial PRIMARY KEY,
    code           text NOT NULL UNIQUE,
    title          text NOT NULL,
    ord            integer NOT NULL,
    -- 'level' is the 1/2/3 scale that gets an ОПШТА ПРОЦЕНКА; 'mark' is the
    -- check columns of the psychological and emotional sections, which have no
    -- arithmetic meaning and must never be averaged.
    scale          text NOT NULL DEFAULT 'level' CHECK (scale IN ('level', 'mark')),
    summary        boolean NOT NULL DEFAULT true,
    only_secondary boolean NOT NULL DEFAULT false,
    active         boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS evidence_groups (
    id         serial PRIMARY KEY,
    section_id integer NOT NULL REFERENCES evidence_sections(id) ON DELETE CASCADE,
    label      text NOT NULL,
    ord        integer NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_items (
    id         serial PRIMARY KEY,
    section_id integer NOT NULL REFERENCES evidence_sections(id) ON DELETE CASCADE,
    group_id   integer REFERENCES evidence_groups(id) ON DELETE CASCADE,
    label      text NOT NULL,
    ord        integer NOT NULL,
    active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS evidence_examiner_roles (
    id         serial PRIMARY KEY,
    section_id integer NOT NULL REFERENCES evidence_sections(id) ON DELETE CASCADE,
    code       text NOT NULL UNIQUE,
    label      text NOT NULL,
    ord        integer NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_periods (
    id             serial PRIMARY KEY,
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    ord            integer NOT NULL,
    label          text NOT NULL,
    short_label    text NOT NULL,
    active         boolean NOT NULL DEFAULT true,
    UNIQUE (school_year_id, ord)
);

CREATE TABLE IF NOT EXISTS evidence_sheets (
    id             serial PRIMARY KEY,
    student_id     integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    school_year_id integer NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
    institution    text NOT NULL DEFAULT '',
    place          text NOT NULL DEFAULT '',
    municipality   text NOT NULL DEFAULT '',
    school_type    text NOT NULL DEFAULT 'primary' CHECK (school_type IN ('primary', 'secondary')),
    class_section  text NOT NULL DEFAULT '',
    vocation       text NOT NULL DEFAULT '',
    occupation     text NOT NULL DEFAULT '',
    dob            text NOT NULL DEFAULT '',
    pob            text NOT NULL DEFAULT '',
    diagnosis      text NOT NULL DEFAULT '',
    place_date     text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text NOT NULL DEFAULT '',
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text NOT NULL DEFAULT '',
    UNIQUE (student_id, school_year_id)
);

CREATE TABLE IF NOT EXISTS evidence_scores (
    sheet_id   integer NOT NULL REFERENCES evidence_sheets(id)  ON DELETE CASCADE,
    item_id    integer NOT NULL REFERENCES evidence_items(id)   ON DELETE CASCADE,
    period_id  integer NOT NULL REFERENCES evidence_periods(id) ON DELETE CASCADE,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL DEFAULT '',
    PRIMARY KEY (sheet_id, item_id, period_id)
);

-- The free-text halves of the form -- вид, слух, говор, биофидбек.  These are
-- paragraphs one specialist writes as a whole, not a grid of contended cells,
-- so they are saved as a form and stored as one document each.
CREATE TABLE IF NOT EXISTS evidence_panels (
    sheet_id   integer NOT NULL REFERENCES evidence_sheets(id) ON DELETE CASCADE,
    panel      text NOT NULL CHECK (panel IN ('vision', 'hearing', 'speech', 'biofeedback')),
    data       jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL DEFAULT '',
    PRIMARY KEY (sheet_id, panel)
);

CREATE TABLE IF NOT EXISTS evidence_examiners (
    sheet_id   integer NOT NULL REFERENCES evidence_sheets(id)          ON DELETE CASCADE,
    role_id    integer NOT NULL REFERENCES evidence_examiner_roles(id)  ON DELETE CASCADE,
    name       text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL DEFAULT '',
    PRIMARY KEY (sheet_id, role_id)
);

CREATE TABLE IF NOT EXISTS evidence_contacts (
    sheet_id   integer NOT NULL REFERENCES evidence_sheets(id) ON DELETE CASCADE,
    ord        integer NOT NULL,
    name       text NOT NULL DEFAULT '',
    profession text NOT NULL DEFAULT '',
    phone      text NOT NULL DEFAULT '',
    email      text NOT NULL DEFAULT '',
    PRIMARY KEY (sheet_id, ord)
);

-- A therapist's PIN, salted and hashed.  Storing it here rather than on
-- `therapists` keeps the shared directory row about the person and this row
-- about one application's sign-in, which can be dropped without touching them.
CREATE TABLE IF NOT EXISTS evidence_logins (
    therapist_id integer PRIMARY KEY REFERENCES therapists(id) ON DELETE CASCADE,
    pin_salt     text NOT NULL,
    pin_hash     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_sessions (
    token        text PRIMARY KEY,
    therapist_id integer NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_items_section   ON evidence_items (section_id, ord);
CREATE INDEX IF NOT EXISTS idx_evidence_sheets_year     ON evidence_sheets (school_year_id);
CREATE INDEX IF NOT EXISTS idx_evidence_scores_period   ON evidence_scores (period_id);
CREATE INDEX IF NOT EXISTS idx_evidence_sessions_expiry ON evidence_sessions (expires_at);

-- The catalogue as the form prints it, generated from the definitions the
-- standalone app carried -- nothing retyped, so the wording stays the
-- Правилник's rather than a paraphrase of it.

INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s1', 'I. ОРГАНИЗИРАНОСТ НА ПСИХОМОТОРИКА', 1, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s2', 'II. ПРАКСИЧКА ОРГАНИЗИРАНОСТ', 2, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s3', 'III. ГНОСТИЧКА ОРГАНИЗИРАНОСТ', 3, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s4', 'IV. ГОВОРНО - ЈАЗИЧНО ПОДРАЧЈЕ', 4, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s5', 'V. СЕНЗОРНО ПОДРАЧЈЕ', 5, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s6', 'VI. ОДНЕСУВАЊЕ', 6, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s7', 'VII. ПСИХОЛОШКО ПОДРАЧЈЕ', 7, 'mark', false, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s8', 'VIII. ЕМОЦИОНАЛНО ПОДРАЧЈЕ', 8, 'mark', false, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s9', 'IX. ПОДРАЧЈЕ НА ЖИВОТНИ ВЕШТИНИ', 9, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s10', 'X. УЧЕЊЕ', 10, 'level', true, false);
INSERT INTO evidence_sections (code, title, ord, scale, summary, only_secondary) VALUES ('s11', 'XI. ОДНОС НА УЧЕНИКОТ КОН ПРАКТИЧНАТА НАСТАВА', 11, 'level', true, true);

INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '1. ОДНЕСУВАЊЕ НА ЧАС', 1 FROM evidence_sections WHERE code = 's6';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '2. ОДНЕСУВАЊЕ НА ОДМОР', 2 FROM evidence_sections WHERE code = 's6';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '3. ОДНЕСУВАЊЕ КОН АВТОРИТЕТ', 3 FROM evidence_sections WHERE code = 's6';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '1. ПОМНЕЊЕ', 1 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '2. ВНИМАНИЕ', 2 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '3. МИСЛЕЊЕ', 3 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '4. ИДЕНТИТЕТ', 4 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '5. САМОКОНТРОЛА', 5 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, '6. МОРАЛЕН РАЗВОЈ', 6 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, 'ЛИЧНИ:', 1 FROM evidence_sections WHERE code = 's9';
INSERT INTO evidence_groups (section_id, label, ord) SELECT id, 'СОЦИЈАЛНИ:', 2 FROM evidence_sections WHERE code = 's9';

INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПСИХОМОТОРИКА НА ДОЛНИТЕ ЕКСТРЕМИТЕТИ', 0 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПСИХОМОТОРИКА НА ГОРНИТЕ ЕКСТРЕМИТЕТИ', 1 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КОНТРОЛА НА МОТОРИКАТА НА ТЕЛОТО ВО ЦЕЛОСТ', 2 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'МОЖНОСТ ЗА ОДРЖУВАЊЕ НА РАМНОТЕЖА НА ТЕЛОТО', 3 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КООРДИНАЦИЈА НА ДВИЖЕЊА', 4 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'МЕЛОКИНЕТИЧКА ПРАКСИЈА', 0 FROM evidence_sections WHERE code = 's2';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОРГАНИЗИРАНОСТ НА ИДЕОМОТОРНА ПРАКСИЈА', 1 FROM evidence_sections WHERE code = 's2';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОРГАНИЗИРАНОСТ НА КОНСТРУКТИВНА ПРАКСИЈА', 2 FROM evidence_sections WHERE code = 's2';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КВАЛИТЕТ НА ЛИНЕАЦИЈА', 3 FROM evidence_sections WHERE code = 's2';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОЗНАВАЊЕ НА ДЕЛОВИТЕ НА ТЕЛОТО', 0 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОЗНАВАЊЕ ЛАТЕРАЛИЗАЦИЈА НА СЕБЕ', 1 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОЗНАВАЊЕ ЛАТЕРАЛИЗАЦИЈА НА ДРУГ', 2 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ДОЖИВУВАЊЕ НА ТЕЛОТО ВО ПРОСТОРОТ', 3 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ЗАПАЗУВАЊЕ НА ОДНОСИТЕ ВО ПРОСТОРОТ И ПРЕТСТАВНИОТ ПРОСТОР', 4 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'РЕПРОДУКЦИЈА НА МОДЕЛ', 5 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ДОЖИВУВАЊЕ И ЗАПАЗУВАЊЕ НА ВРЕМЕ', 6 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СНАОЃАЊЕ ВО МИКРО ПРОСТОР', 7 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СНАОЃАЊЕ ВО МАКРО ПРОСТОР', 8 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КВАЛИТЕТ НА ГЛАСОТ', 0 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'РИТАМ И ТЕМПО НА ГОВОРОТ', 1 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'АРТИКУЛАЦИЈА И УПОТРЕБА НА ГЛАСОВИТЕ', 2 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПАСИВЕН ГОВОР', 3 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'АКТИВЕН ГОВОР', 4 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ЛЕКСИЧКИ СПОСОБНОСТИ', 5 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПРАВОПИСНО НИВО НА РАКОПИС -ДИСОРТОГРАФИЈА', 6 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'РАЗВИЕНОСТ НА СЕМАНТИЧКО НИВО НА ГОВОР', 7 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КОГНИТИВЕН И ЈАЗИЧКИ РАЗВОЈ', 8 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'АУДИТИВНО ПРОЦЕСУИРАЊЕ', 0 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ВЕСТИБУЛАРНО ПРОЦЕСУИРАЊЕ', 1 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ТАКТИЛНО ПРОЦЕСУИРАЊЕ', 2 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ГУСТАТИВНО ПРОЦЕСУИРАЊЕ', 3 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОЛФАКТОРНО ПРОЦЕСУИРАЊЕ', 4 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ВИЗУЕЛНО ПРОЦЕСУИРАЊЕ', 5 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПРОПРИОЦЕПТИВНО ПРОЦЕСУИРАЊЕ', 6 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'на местото каде седи', 0 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'во однос кон соседните ученици', 1 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'внимание', 2 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'расположение', 3 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'во училишниот двор', 4 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'во однос на игра', 5 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'во однос на група ученици', 6 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'расположение', 7 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'се обраќа на наставникот', 8 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'однесување кон налозите на наставникот', 9 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'пофалби', 10 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'опомени', 11 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's6';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'механичко помнење', 0 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'логичко помнење', 1 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'краткотрајно', 2 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'долготрајно', 3 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'концентрирано', 4 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'површно (дистрактибилно) внимание', 5 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'дистрибуирано', 6 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'флуктуирачко', 7 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'сензомоторно', 8 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'предоперационално', 9 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'конкретно', 10 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'формално', 11 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 3 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'високо мислење за себе', 12 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 4 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'добро мислење за себе', 13 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 4 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'ниско мислење за себе', 14 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 4 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, '5. САМОКОНТРОЛА', 15 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 5 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'нема поим за моралност', 16 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 6 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'хетерономна моралност', 17 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 6 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'автономна моралност', 18 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 6 WHERE s.code = 's7';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПРИОЃА И РАЗГОВАРА СО ДРУГИТЕ', 0 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОКАЖУВА СПОСОБНОСТ ЗА СОРАБОТКА', 1 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОСТОЈАНО Е СО РОДИТЕЛ', 2 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СЕ СРАМИ', 3 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СЛОБОДНО КОМУНИЦИРА', 4 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПАНИЧЕН СТРАВ', 5 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'АВТОАГРЕСИЈА', 6 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ИСПАДИ НА БЕС', 7 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОСТОЈАНО ПРОЈАВУВА ГНЕВ', 8 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'НЕКОНТРОЛИРАНО СМЕЕЊЕ', 9 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ПОСТОЈАНО ТАЖЕН', 10 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'ОДРЖУВА ЛИЧНА ХИГИЕНА', 0 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'КОРИСТИ ТОАЛЕТ', 1 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'САМОСТОЈНО СЕ ОБЛЕКУВА', 2 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'УПОТРЕБУВА ПРИБОР ЗА ЈАДЕЊЕ', 3 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'ОДГОВОРНОСТ ВО ЗАШТИТА НА ЖИВОТНАТА СРЕДИНА', 4 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'ПРИЛАГОДУВА ОДНЕСУВАЊЕ ЗАРАДИ ЛИЧНА БЕЗБЕДНОСТ', 5 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 1 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'УПОТРЕБУВА ПАРИ', 6 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'УПОТРЕБУВА ЧАСОВНИК', 7 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'УПОТРЕБУВА ТЕЛЕФОН', 8 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'КОРИСТИ ЈАВЕН ПРЕВОЗ', 9 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'ПРИФАЌА ОДРЕДЕНИ ПРАВИЛА', 10 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, group_id, label, ord) SELECT s.id, g.id, 'БАРА ПОМОШ', 11 FROM evidence_sections s JOIN evidence_groups g ON g.section_id = s.id AND g.ord = 2 WHERE s.code = 's9';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'РАЗБИРА ОСНОВНИ НАЛОЗИ ЗА УЧЕЊЕ', 0 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ИЗВРШУВА НАЛОЗИ ЗА УЧЕЊЕ', 1 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ НЕВЕРБАЛНО', 2 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ ВЕРБАЛНО', 3 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ МЕХАНИЧКИ', 4 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ СО РАЗБИРАЊЕ', 5 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ СО ИНТЕРЕС', 6 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УЧИ САМОСТОЈНО', 7 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ИСТРАЈНОСТ ВО УЧЕЊЕТО', 8 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОДНОС КОН СТРУКАТА-ЗАНИМАЊЕТО', 0 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОДНОС КОН СРЕДСТАВАТА ЗА РАБОТА', 1 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОДНОС КОН НАСТАВНИКОТ ПО ПРАКТИЧНА НАСТАВА', 2 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'РАБОТНА ДИСЦИПЛИНА', 3 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'УРЕДНОСТ ВО РАБОТАТА', 4 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ТЕМПО НА РАБОТА', 5 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КВАНТИТЕТ НА РАБОТА', 6 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СМИСЛА ЗА ОРГАНИЗАЦИЈА И СОРАБОТКА', 7 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КОМУНИКАЦИЈА СО ОКОЛИНАТА', 8 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'СНАОДЛИВОСТ ВО РАБОТАТА', 9 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ВООЧУВАЊЕ ГРЕШКИ', 10 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ОТСТРАНУВАЊЕ НА ГРЕШКИ', 11 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ЈА ВРШИ РАБОТАТА САМОСТОЈНО', 12 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'КВАЛИТЕТ ВО РАБОТАТА', 13 FROM evidence_sections WHERE code = 's11';
INSERT INTO evidence_items (section_id, label, ord) SELECT id, 'ИСТРАЈНОСТ ВО РАБОТАТА', 14 FROM evidence_sections WHERE code = 's11';

INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s1', 'дефектолог испитувач', 1 FROM evidence_sections WHERE code = 's1';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s2', 'дефектолог испитувач', 1 FROM evidence_sections WHERE code = 's2';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s3', 'дефектолог испитувач', 1 FROM evidence_sections WHERE code = 's3';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s4d', 'дефектолог- испитувач', 1 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s4l', 'логопед- испитувач', 2 FROM evidence_sections WHERE code = 's4';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s5', 'дефектолог- испитувач', 1 FROM evidence_sections WHERE code = 's5';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s6', 'дефектолог-испитувач', 1 FROM evidence_sections WHERE code = 's6';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s7', 'психолог – испитувач', 1 FROM evidence_sections WHERE code = 's7';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s8', 'психолог – испитувач', 1 FROM evidence_sections WHERE code = 's8';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s9', 'дефектолог/одделенски/ класен/ воспитувач', 1 FROM evidence_sections WHERE code = 's9';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s10', 'дефектолог/одделенски/ класен/', 1 FROM evidence_sections WHERE code = 's10';
INSERT INTO evidence_examiner_roles (section_id, code, label, ord) SELECT id, 'ex_s11', 'занимање на испитувачот', 1 FROM evidence_sections WHERE code = 's11';

COMMIT;
