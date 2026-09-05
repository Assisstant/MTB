import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';
import { scheduleWriteRoutes } from '../src/routes/schedule-write.js';
import { rosterWriteRoutes } from '../src/routes/roster-write.js';
import { evidenceRoutes } from '../src/routes/evidence.js';
import { evidenceAuthRoutes } from '../src/routes/evidence-auth.js';
import { categoryRoutes } from '../src/routes/categories.js';
import { stateRoutes } from '../src/routes/state.js';
import { installColleagueBoundary } from '../src/lib/colleague.js';

/**
 * Colleague permission and isolation e2e tests.
 *
 * Implements the assertions defined in docs/PLAN-kolegi-pristap.md, plus the
 * perimeter cases that make the policy default-deny rather than route-by-route:
 * 1. with MTB_REQUIRE_SIGNIN unset, every endpoint answers open (owner workflow safe);
 * 2. therapist A signed in cannot change schedule for therapist B -> 403;
 * 3. therapist A cannot tick a pupil onto B's caseload -> 403;
 * 4. A token idle past MTB_SESSION_IDLE_MINUTES -> 401 signedOut;
 * 5. /api/evidence/sheets signed in as A returns only A's caseload;
 * 6. A colleague cannot POST /api/students -> 403, but the owner can;
 * 7. a newly added write route is admin-only without being named in the policy;
 * 8. direct sheet ids cannot cross the pupil boundary;
 * 9. a teacher sharing the admin's display name does not inherit admin rights.
 *
 * Fixtures use invented names only (Rule 1).
 */

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');

const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1915/1916-colleague';
const TAG = 'colleague-test';
const OWNER_NAME = 'Пробен Админ Сопственик';
const THERAPIST_A_NAME = 'Пробен Терапевт А';
const THERAPIST_B_NAME = 'Пробен Терапевт Б';
const NO_PIN_NAME = 'Пробен Терапевт Без PIN';
const TEACHER_CLASS = `${TAG}-I-a`;
const STATE_APP = `${TAG}-guard-probe`;
const SERVICE_KEY = 'colleague-test-service-key-0123456789abcdef';

let fails = 0;
const check = (label: string, condition: boolean, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function cleanup() {
    await q('DELETE FROM app_state WHERE app = $1', [STATE_APP]);
    await q('DELETE FROM school_years WHERE label = $1', [YEAR]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [`${TAG}%`]);
    await q('DELETE FROM teachers WHERE name = $1', [OWNER_NAME]);
    await q('DELETE FROM therapists WHERE name LIKE $1', [`%${TAG}%`]);
    await q('DELETE FROM therapists WHERE name IN ($1, $2, $3, $4)',
        [OWNER_NAME, THERAPIST_A_NAME, THERAPIST_B_NAME, NO_PIN_NAME]);
    await q('DELETE FROM school_classes WHERE label = $1', [TEACHER_CLASS]);
}

async function buildApp() {
    const app = Fastify({ logger: false });
    installColleagueBoundary(app);
    // This deliberately has no local guard and is absent from the allowlist.
    // If the global hook stops being global/default-deny, the test turns red.
    app.post('/api/test/unlisted-write', async () => ({ ok: true }));
    await app.register(evidenceAuthRoutes);
    await app.register(evidenceRoutes);
    await app.register(categoryRoutes);
    await app.register(stateRoutes);
    await app.register(scheduleWriteRoutes);
    await app.register(rosterWriteRoutes);
    await app.ready();
    return app;
}

async function run() {
    console.log('\n--- Colleague Permission Guard Tests ---');
    const previousEnv = {
        requireSignin: process.env.MTB_REQUIRE_SIGNIN,
        admin: process.env.MTB_ADMIN,
        serviceKey: process.env.MTB_SERVICE_KEY,
        idleMinutes: process.env.MTB_SESSION_IDLE_MINUTES
    };
    // A developer may run this against a server/.env where enforcement is
    // already enabled.  Fixture PIN provisioning deliberately starts in the
    // compatibility/open mode and the test turns enforcement on itself.
    delete process.env.MTB_REQUIRE_SIGNIN;
    delete process.env.MTB_ADMIN;
    delete process.env.MTB_SERVICE_KEY;

    await cleanup();
    const app = await buildApp();

    try {
        // 1. Seed school year, therapists and students
        const [year] = await q(
            `INSERT INTO school_years (label, starts_on, ends_on, is_current)
             VALUES ($1, '1915-09-01', '1916-08-31', false) RETURNING id`, [YEAR]
        );
        const yearId = year.id;

        const [thOwner] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [OWNER_NAME]);
        const [thA] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [THERAPIST_A_NAME]);
        const [thB] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [THERAPIST_B_NAME]);
        const [thNoPin] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [NO_PIN_NAME]);
        const [sameNameTeacher] = await q(
            `INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [OWNER_NAME]);

        // Register therapists for the school year
        await q(
            `INSERT INTO therapist_years (school_year_id, therapist_id, active)
             VALUES ($1, $2, true), ($1, $3, true), ($1, $4, true), ($1, $5, true)`,
            [yearId, thOwner.id, thA.id, thB.id, thNoPin.id]
        );

        const [st1] = await q(
            `INSERT INTO students (public_id, name, grade, active)
             VALUES ($1, 'Пробно Дете Еден', 'I-a', true) RETURNING id`, [`${TAG}-st1`]
        );
        const [st2] = await q(
            `INSERT INTO students (public_id, name, grade, active)
             VALUES ($1, 'Пробно Дете Два', 'II-b', true) RETURNING id`, [`${TAG}-st2`]
        );

        // Enroll students in the school year
        await q(
            `INSERT INTO student_enrollments (school_year_id, student_id, active, grade)
             VALUES ($1, $2, true, $4), ($1, $3, true, 'II-b')`,
            [yearId, st1.id, st2.id, TEACHER_CLASS]
        );

        const [teacherClass] = await q(
            `INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id`,
            [TEACHER_CLASS, `zz-${TAG}`]);
        await q(
            `INSERT INTO teacher_years (school_year_id, teacher_id, active)
             VALUES ($1, $2, true)`, [yearId, sameNameTeacher.id]);
        await q(
            `INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
             VALUES ($1, $2, $3, 'homeroom')`, [yearId, sameNameTeacher.id, teacherClass.id]);

        // Link student 1 to Therapist A's caseload for this year
        await q(
            `INSERT INTO therapist_students (therapist_id, student_id, school_year_id)
             VALUES ($1, $2, $3)`, [thA.id, st1.id, yearId]
        );
        // Link student 2 to Therapist B's caseload for this year
        await q(
            `INSERT INTO therapist_students (therapist_id, student_id, school_year_id)
             VALUES ($1, $2, $3)`, [thB.id, st2.id, yearId]
        );

        // Setup PINs and logins
        await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            payload: { therapistId: thA.id, pin: '1111' }
        });
        await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            payload: { therapistId: thB.id, pin: '2222' }
        });
        await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            payload: { therapistId: thOwner.id, pin: '9999' }
        });
        await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            payload: { kind: 'teacher', personId: sameNameTeacher.id, pin: '3333' }
        });

        // Login to obtain session tokens
        const loginARes = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: thA.id, pin: '1111' }
        });
        const tokenA = loginARes.json().token as string;

        const loginBRes = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: thB.id, pin: '2222' }
        });
        const tokenB = loginBRes.json().token as string;

        const loginOwnerRes = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: thOwner.id, pin: '9999' }
        });
        const tokenOwner = loginOwnerRes.json().token as string;

        const loginSameNameTeacherRes = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { kind: 'teacher', personId: sameNameTeacher.id, pin: '3333' }
        });
        const tokenSameNameTeacher = loginSameNameTeacherRes.json().token as string;

        check('Tokens successfully created for A, B, Owner, and same-name teacher',
            Boolean(tokenA && tokenB && tokenOwner && tokenSameNameTeacher));

        // --- TEST 1: with MTB_REQUIRE_SIGNIN unset, endpoints are open ---
        delete process.env.MTB_REQUIRE_SIGNIN;
        delete process.env.MTB_ADMIN;

        const openRes = await app.inject({
            method: 'PUT',
            url: `/api/therapists/${encodeURIComponent(THERAPIST_A_NAME)}/students/${TAG}-st2?year=${YEAR}`
        });
        check('1. With MTB_REQUIRE_SIGNIN unset, write is open without token (200)', openRes.statusCode === 200);
        const openUnlisted = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write'
        });
        check('Compatibility mode also leaves future/unlisted writes open', openUnlisted.statusCode === 200);

        // Clean back up for the next test
        await q(
            `DELETE FROM therapist_students WHERE therapist_id = $1 AND student_id = $2 AND school_year_id = $3`,
            [thA.id, st2.id, yearId]
        );

        // --- ENFORCEMENT ON ---
        process.env.MTB_REQUIRE_SIGNIN = '1';
        process.env.MTB_ADMIN = OWNER_NAME;
        process.env.MTB_SERVICE_KEY = SERVICE_KEY;
        process.env.MTB_SESSION_IDLE_MINUTES = '30';

        const firstPinByColleague = await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            headers: { 'X-MTB-Evidence-Token': tokenB },
            payload: { therapistId: thNoPin.id, pin: '4444' }
        });
        check('A colleague cannot claim another person\'s first PIN after enforcement',
            firstPinByColleague.statusCode === 403 && Boolean(firstPinByColleague.json().needsAdmin));
        const firstPinByOwner = await app.inject({
            method: 'POST', url: '/api/evidence/pin',
            headers: { 'X-MTB-Evidence-Token': tokenOwner },
            payload: { therapistId: thNoPin.id, pin: '4444' }
        });
        check('The configured owner can provision a colleague\'s first PIN',
            firstPinByOwner.statusCode === 200 && firstPinByOwner.json().created === true);

        // --- DEFAULT-DENY PERIMETER ---
        const unlistedNoToken = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write'
        });
        check('Default-deny: an unlisted write without a token -> 401',
            unlistedNoToken.statusCode === 401 && Boolean(unlistedNoToken.json().signedOut));

        const unlistedColleague = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write',
            headers: { 'X-MTB-Evidence-Token': tokenB }
        });
        check('Default-deny: an unlisted write by a colleague -> 403 needsAdmin',
            unlistedColleague.statusCode === 403 && Boolean(unlistedColleague.json().needsAdmin));

        const unlistedOwner = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write',
            headers: { 'X-MTB-Evidence-Token': tokenOwner }
        });
        check('Default-deny: the configured owner reaches an unlisted write',
            unlistedOwner.statusCode === 200);

        const unlistedService = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write',
            headers: { 'X-MTB-Service-Key': SERVICE_KEY }
        });
        check('Maintenance service key reaches an admin-only write', unlistedService.statusCode === 200);

        const stateNoToken = await app.inject({
            method: 'PUT', url: `/api/state/${STATE_APP}`,
            payload: { baseVersion: 0, payload: { probe: true } }
        });
        const stateColleague = await app.inject({
            method: 'PUT', url: `/api/state/${STATE_APP}`,
            headers: { 'X-MTB-Evidence-Token': tokenB },
            payload: { baseVersion: 0, payload: { probe: true } }
        });
        const stateService = await app.inject({
            method: 'PUT', url: `/api/state/${STATE_APP}`,
            headers: { 'X-MTB-Service-Key': SERVICE_KEY },
            payload: { baseVersion: 0, payload: { probe: true } }
        });
        check('Real whole-document state writes are default-deny',
            stateNoToken.statusCode === 401 && stateColleague.statusCode === 403,
            `${stateNoToken.statusCode}/${stateColleague.statusCode}`);
        check('The service key preserves scheduled state sync without a human session',
            stateService.statusCode === 200 && stateService.json().version === 1,
            JSON.stringify(stateService.json()));

        const sameNameImpersonation = await app.inject({
            method: 'POST', url: '/api/test/unlisted-write',
            headers: { 'X-MTB-Evidence-Token': tokenSameNameTeacher }
        });
        check('Same-name teacher does not inherit therapist admin rights',
            sameNameImpersonation.statusCode === 403 && Boolean(sameNameImpersonation.json().needsAdmin));

        // Unauthenticated request with enforcement on -> 401
        const noTokenRes = await app.inject({
            method: 'PUT',
            url: `/api/therapists/${encodeURIComponent(THERAPIST_A_NAME)}/students/${TAG}-st2?year=${YEAR}`
        });
        check('Enforcement on: request without token returns 401', noTokenRes.statusCode === 401);

        // --- TEST 2: Therapist A cannot PUT schedule slot for Therapist B -> 403 ---
        const scheduleOtherRes = await app.inject({
            method: 'PUT',
            url: '/api/schedule/session',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: {
                therapistId: thB.id,
                day: 'среда',
                time: '08:00 - 08:20',
                studentPublicId: `${TAG}-st2`,
                year: YEAR
            }
        });
        check('2. Therapist A cannot write schedule session for Therapist B -> 403', scheduleOtherRes.statusCode === 403);

        // Therapist A writing their own schedule -> not 403 (200)
        const scheduleOwnRes = await app.inject({
            method: 'PUT',
            url: '/api/schedule/session',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: {
                therapistId: thA.id,
                day: 'среда',
                time: '08:00 - 08:20',
                studentPublicId: `${TAG}-st1`,
                year: YEAR
            }
        });
        check('Therapist A can write their own schedule session -> 200', scheduleOwnRes.statusCode === 200);

        const legacySlotRes = await app.inject({
            method: 'PUT',
            url: '/api/schedule/slot',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: {
                therapist: THERAPIST_A_NAME,
                day: 'среда',
                time: '09:00-09:40',
                student: null,
                year: YEAR
            }
        });
        check('Legacy name-based schedule writer stays admin-only -> 403', legacySlotRes.statusCode === 403);

        // --- TEST 3: Therapist A cannot tick a pupil onto B caseload -> 403 ---
        const caseloadOtherRes = await app.inject({
            method: 'PUT',
            url: `/api/therapists/${encodeURIComponent(THERAPIST_B_NAME)}/students/${TAG}-st1?year=${YEAR}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        check('3. Therapist A cannot tick pupil onto Therapist B caseload -> 403', caseloadOtherRes.statusCode === 403);

        // Therapist A ticking pupil onto A's own caseload -> succeeds (200)
        const caseloadOwnRes = await app.inject({
            method: 'PUT',
            url: `/api/therapists/${encodeURIComponent(THERAPIST_A_NAME)}/students/${TAG}-st2?year=${YEAR}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        check('Therapist A can tick pupil onto own caseload -> 200', caseloadOwnRes.statusCode === 200);

        // Put the fixture back into its original ownership split before probing
        // direct sheet ids; otherwise Student 2 would now legitimately be A's.
        await q(
            `DELETE FROM therapist_students WHERE therapist_id = $1 AND student_id = $2 AND school_year_id = $3`,
            [thA.id, st2.id, yearId]
        );

        // --- DIRECT SHEET IDS MUST NOT BYPASS THE LIST FILTER ---
        const createSheetB = await app.inject({
            method: 'POST',
            url: '/api/evidence/sheet',
            headers: { 'X-MTB-Evidence-Token': tokenB },
            payload: { publicId: `${TAG}-st2`, year: YEAR }
        });
        const sheetB = createSheetB.json().sheetId as number;
        check('Therapist B creates a sheet for their own pupil',
            createSheetB.statusCode === 200 && Number.isInteger(sheetB), JSON.stringify(createSheetB.json()));

        const directReadByA = await app.inject({
            method: 'GET', url: `/api/evidence/sheet/${sheetB}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        check('A cannot read B pupil sheet by direct id -> 403', directReadByA.statusCode === 403);

        const directPatchByA = await app.inject({
            method: 'PATCH', url: `/api/evidence/sheet/${sheetB}`,
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: { place: 'Недозволена промена' }
        });
        check('A cannot patch B pupil sheet by direct id -> 403', directPatchByA.statusCode === 403);

        const directPanelByA = await app.inject({
            method: 'PUT', url: '/api/evidence/panel',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: { sheetId: sheetB, panel: 'vision', data: { note: 'Недозволено' } }
        });
        check('A cannot write a panel on B pupil sheet -> 403', directPanelByA.statusCode === 403);

        const directSectionOverrideByA = await app.inject({
            method: 'PUT', url: '/api/evidence/sheet-section',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: { sheetId: sheetB, sectionId: 1, included: true }
        });
        check('A cannot change section inclusion on B pupil sheet -> 403',
            directSectionOverrideByA.statusCode === 403);

        const directSectionsReadByA = await app.inject({
            method: 'GET', url: `/api/evidence/sheet-sections?sheet=${sheetB}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        check('A cannot read B pupil section choices by direct sheet id -> 403',
            directSectionsReadByA.statusCode === 403);

        const directPatchByB = await app.inject({
            method: 'PATCH', url: `/api/evidence/sheet/${sheetB}`,
            headers: { 'X-MTB-Evidence-Token': tokenB },
            payload: { place: 'Пробно место' }
        });
        check('B can patch their own pupil sheet', directPatchByB.statusCode === 200);

        const createSheetA = await app.inject({
            method: 'POST',
            url: '/api/evidence/sheet',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: { publicId: `${TAG}-st1`, year: YEAR }
        });
        const sheetA = createSheetA.json().sheetId as number;
        await app.inject({
            method: 'GET',
            url: `/api/evidence/catalog?year=${encodeURIComponent(YEAR)}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        const [prescribed] = await q(
            `SELECT i.id AS item_id, s.id AS section_id, s.scale
               FROM evidence_items i
               JOIN evidence_sections s ON s.id = i.section_id
              WHERE i.active AND s.active AND s.catalog = 'prescribed'
              ORDER BY s.ord, i.ord LIMIT 1`);
        const [period] = await q(
            `SELECT id FROM evidence_periods
              WHERE school_year_id = $1 AND active ORDER BY ord LIMIT 1`, [yearId]);
        const ownPrescribedScore = await app.inject({
            method: 'PUT', url: '/api/evidence/score',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: {
                sheetId: sheetA,
                itemId: prescribed.item_id,
                periodId: period.id,
                value: prescribed.scale === 'mark' ? '√' : '1',
                expected: ''
            }
        });
        check('A can score the prescribed form for their own pupil',
            ownPrescribedScore.statusCode === 200, JSON.stringify(ownPrescribedScore.json()));

        const teacherSheets = await app.inject({
            method: 'GET', url: `/api/evidence/sheets?year=${encodeURIComponent(YEAR)}`,
            headers: { 'X-MTB-Evidence-Token': tokenSameNameTeacher }
        });
        const teacherPupils = (teacherSheets.json().pupils || []).map((pupil: any) => pupil.public_id);
        check('A teacher owns pupils through the existing annual class assignment',
            teacherSheets.statusCode === 200 && teacherPupils.includes(`${TAG}-st1`)
                && !teacherPupils.includes(`${TAG}-st2`), JSON.stringify(teacherPupils));
        const teacherOwnSheet = await app.inject({
            method: 'GET', url: `/api/evidence/sheet/${sheetA}`,
            headers: { 'X-MTB-Evidence-Token': tokenSameNameTeacher }
        });
        const teacherOtherSheet = await app.inject({
            method: 'GET', url: `/api/evidence/sheet/${sheetB}`,
            headers: { 'X-MTB-Evidence-Token': tokenSameNameTeacher }
        });
        check('The class teacher can read their pupil sheet but not another class',
            teacherOwnSheet.statusCode === 200 && teacherOtherSheet.statusCode === 403,
            `${teacherOwnSheet.statusCode}/${teacherOtherSheet.statusCode}`);

        const otherPrescribedScore = await app.inject({
            method: 'PUT', url: '/api/evidence/score',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: {
                sheetId: sheetB,
                itemId: prescribed.item_id,
                periodId: period.id,
                value: prescribed.scale === 'mark' ? '√' : '1',
                expected: ''
            }
        });
        check('A cannot score the prescribed form for B pupil -> 403',
            otherPrescribedScore.statusCode === 403);

        const prescribedStructureByA = await app.inject({
            method: 'POST', url: '/api/evidence/item',
            headers: { 'X-MTB-Evidence-Token': tokenA },
            payload: { sectionId: prescribed.section_id, label: 'Недозволена структурна ставка' }
        });
        check('A cannot change the shared prescribed catalogue -> 403 needsAdmin',
            prescribedStructureByA.statusCode === 403 &&
            Boolean(prescribedStructureByA.json().needsAdmin));

        // --- TEST 4: Token idle past MTB_SESSION_IDLE_MINUTES -> 401 signedOut ---
        await q(
            `UPDATE evidence_sessions SET last_seen = now() - interval '35 minutes' WHERE token = $1`,
            [tokenA]
        );
        const idleRes = await app.inject({
            method: 'PUT',
            url: `/api/therapists/${encodeURIComponent(THERAPIST_A_NAME)}/students/${TAG}-st2?year=${YEAR}`,
            headers: { 'X-MTB-Evidence-Token': tokenA }
        });
        const idleBody = idleRes.json();
        check('4. Token idle past 30 minutes -> 401 signedOut', idleRes.statusCode === 401 && Boolean(idleBody.signedOut));

        // --- TEST 5: /api/evidence/sheets signed in as B returns only B caseload ---
        const sheetsBRes = await app.inject({
            method: 'GET',
            url: `/api/evidence/sheets?year=${encodeURIComponent(YEAR)}`,
            headers: { 'X-MTB-Evidence-Token': tokenB }
        });
        check('Sheets query succeeds for B -> 200', sheetsBRes.statusCode === 200);
        const pupilsB = sheetsBRes.json().pupils || [];
        const publicIdsB = pupilsB.map((p: any) => p.public_id);
        check('5. /api/evidence/sheets as Therapist B returns only Student 2 (B caseload)',
            publicIdsB.includes(`${TAG}-st2`) && !publicIdsB.includes(`${TAG}-st1`)
        );

        // --- TEST 6: Colleague cannot POST /api/students -> 403, Owner can ---
        const colleagueAddStudent = await app.inject({
            method: 'POST',
            url: '/api/students',
            headers: { 'X-MTB-Evidence-Token': tokenB },
            payload: { name: 'Недозволен Ученик', grade: 'I-a', year: YEAR }
        });
        check('6a. Colleague cannot POST /api/students -> 403', colleagueAddStudent.statusCode === 403);

        const ownerAddStudent = await app.inject({
            method: 'POST',
            url: '/api/students',
            headers: { 'X-MTB-Evidence-Token': tokenOwner },
            payload: { name: 'Дозволен Ученик Од Админ', grade: 'I-a', year: YEAR }
        });
        check('6b. Owner can POST /api/students -> 200/201', ownerAddStudent.statusCode === 200 || ownerAddStudent.statusCode === 201);
        if (ownerAddStudent.json()?.student?.public_id) {
            await q('DELETE FROM students WHERE public_id = $1', [ownerAddStudent.json().student.public_id]);
        }

        // Four digits need an online-guess limit. Invalid shapes are rejected
        // without doing scrypt work; five valid-looking failures temporarily
        // lock this identity, including a subsequently correct guess.
        const malformedPin = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: thNoPin.id, pin: 'abcd' }
        });
        check('A PIN is exactly four digits at the API boundary',
            malformedPin.statusCode === 400 && Boolean(malformedPin.json().invalidPin));
        const guesses = [];
        for (const pin of ['0000', '0001', '0002', '0003', '0004']) {
            guesses.push(await app.inject({
                method: 'POST', url: '/api/evidence/login',
                payload: { therapistId: thNoPin.id, pin }
            }));
        }
        check('Five wrong PIN guesses activate the temporary lock',
            guesses.slice(0, 4).every((res) => res.statusCode === 401) &&
            guesses[4].statusCode === 429 && Number(guesses[4].headers['retry-after']) > 0);
        const blockedCorrectPin = await app.inject({
            method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: thNoPin.id, pin: '4444' }
        });
        check('The lock cannot be bypassed by guessing the correct PIN next',
            blockedCorrectPin.statusCode === 429);

    } finally {
        await cleanup();
        await app.close();
        await pool.end();
        delete process.env.MTB_REQUIRE_SIGNIN;
        delete process.env.MTB_ADMIN;
        delete process.env.MTB_SERVICE_KEY;
        delete process.env.MTB_SESSION_IDLE_MINUTES;
        if (previousEnv.requireSignin !== undefined) process.env.MTB_REQUIRE_SIGNIN = previousEnv.requireSignin;
        if (previousEnv.admin !== undefined) process.env.MTB_ADMIN = previousEnv.admin;
        if (previousEnv.serviceKey !== undefined) process.env.MTB_SERVICE_KEY = previousEnv.serviceKey;
        if (previousEnv.idleMinutes !== undefined) process.env.MTB_SESSION_IDLE_MINUTES = previousEnv.idleMinutes;
    }

    console.log(`\nResults: ${fails === 0 ? 'ALL PASSED' : `${fails} FAILED`}`);
    if (fails > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
