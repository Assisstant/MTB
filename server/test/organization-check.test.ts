/**
 * The organisation preflight, on an invented school and an invented schema.
 *
 * NO DATABASE IS TOUCHED HERE, and that is deliberate rather than convenient:
 * the rules have to be provable without the live HOME/WORK/Supabase data, and
 * `MTB_SCRATCH_DB=1` does not make a live database safe. Every row below names
 * people who do not exist — in fact it names nobody at all, because the check
 * itself reads only technical ids (rule 1).
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzeOrganization,
    exitCodeFor,
    formatOrganizationReport,
    safeOrganizationError,
    readOrganization,
    EXIT,
    OrganizationReadError,
    type CategoryRow,
    type HomeroomRow,
    type OrganizationInput,
    type YearRow
} from '../src/lib/organization-check.js';

const YEARS: YearRow[] = [
    { id: 1, label: '2025/2026', is_current: false },
    { id: 2, label: '2026/2027', is_current: true }
];

const homeroom = (year: number, teacher: number, cls: number, over: Partial<HomeroomRow> = {}): HomeroomRow => ({
    year_id: year,
    teacher_id: teacher,
    class_id: cls,
    teacher_listed: true,
    teacher_active: true,
    class_listed: true,
    class_active: true,
    ...over
});

const category = (
    year: number,
    kind: 'teacher' | 'therapist',
    profile: number,
    categoryId: number,
    over: Partial<CategoryRow> = {}
): CategoryRow => ({
    profile_kind: kind,
    year_id: year,
    profile_id: profile,
    category_id: categoryId,
    active: true,
    employee_id: null,
    ...over
});

const input = (over: Partial<OrganizationInput> = {}): OrganizationInput => ({
    database: 'invented_db',
    migrations: { count: 36, latest: '036_workspace_api_privacy.sql' },
    capabilities: { employees: true, employeeRoles: true, profileEmployeeId: true, categories: true },
    years: YEARS,
    homerooms: [],
    categories: [],
    employeeRoles: [],
    ...over
});

test('a clean school produces no finding and exit code 0', () => {
    const report = analyzeOrganization(
        input({
            homerooms: [homeroom(2, 10, 100), homeroom(2, 11, 101), homeroom(1, 10, 100)],
            categories: [category(2, 'therapist', 5, 7, { employee_id: 50 })]
        })
    );
    assert.equal(report.findings.length, 0);
    assert.equal(exitCodeFor(report), EXIT.ok);
});

test('a class with two homeroom teachers is a finding, in the year it happened', () => {
    const report = analyzeOrganization({
        ...input(),
        homerooms: [homeroom(2, 10, 100), homeroom(2, 11, 100)]
    });
    const found = report.findings.filter((f) => f.code === 'class-multiple-homerooms');
    assert.equal(found.length, 1);
    assert.equal(found[0].level, 'fault');
    assert.equal(found[0].year.label, '2026/2027');
    assert.deepEqual(found[0].code === 'class-multiple-homerooms' ? found[0].teacherIds : [], [10, 11]);
    assert.equal(exitCodeFor(report), EXIT.finding);
});

test('a teacher leading two classes in one year is a finding', () => {
    const report = analyzeOrganization({
        ...input(),
        homerooms: [homeroom(2, 10, 100), homeroom(2, 10, 101)]
    });
    const found = report.findings.filter((f) => f.code === 'teacher-multiple-homerooms');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].code === 'teacher-multiple-homerooms' ? found[0].classIds : [], [100, 101]);
    assert.equal(exitCodeFor(report), EXIT.finding);
});

test('the same duty in DIFFERENT years is not a finding', () => {
    // The whole point of an annual membership: leading I-а last year and II-а
    // this year is a career, not a contradiction.
    const report = analyzeOrganization({
        ...input(),
        homerooms: [homeroom(1, 10, 100), homeroom(2, 10, 101)]
    });
    assert.equal(report.faults, 0);
    assert.equal(exitCodeFor(report), EXIT.ok);
});

test('a violation ONLY in an archived year is still found, and marked as archived', () => {
    // An archived year has to keep reading correctly; a check that looks at the
    // current year alone would report this school as clean.
    const report = analyzeOrganization({
        ...input(),
        homerooms: [homeroom(1, 10, 100), homeroom(1, 11, 100), homeroom(2, 10, 100)]
    });
    assert.equal(report.faults, 1);
    assert.equal(report.findings[0].year.label, '2025/2026');
    assert.equal(report.findings[0].year.current, false);
    assert.equal(exitCodeFor(report), EXIT.finding);
});

test('the finding separates who is ACTIVE this year from who merely has the row', () => {
    const report = analyzeOrganization({
        ...input(),
        homerooms: [homeroom(2, 10, 100), homeroom(2, 11, 100, { teacher_active: false, teacher_listed: false })]
    });
    const f = report.findings[0];
    assert.equal(f.code, 'class-multiple-homerooms');
    if (f.code !== 'class-multiple-homerooms') return;
    assert.deepEqual(f.teacherIds, [10, 11]);
    assert.deepEqual(f.activeTeacherIds, [10]);
});

test('several subject teachers in one class are allowed — only homeroom rows are read', async () => {
    // The rule is about раководство, not about who enters the classroom. The
    // SQL is what enforces it, so the SQL is what this asserts: dropping the
    // role filter would turn every ordinary subject teacher into a finding.
    const seen: string[] = [];
    await readOrganization(fake({ capture: seen }));
    const homeroomSql = seen.find((s) => s.includes('FROM teacher_classes')) ?? '';
    assert.match(homeroomSql, /tc\.role = 'homeroom'/);
});

test('a repeated profession is informative, never a failure', () => {
    // Three logopedists is a school, not a fault.
    const report = analyzeOrganization({
        ...input(),
        categories: [
            category(2, 'therapist', 5, 7, { employee_id: 50 }),
            category(2, 'therapist', 6, 7, { employee_id: 51 }),
            category(2, 'teacher', 12, 7, { employee_id: 52 })
        ]
    });
    assert.equal(report.faults, 0);
    assert.equal(report.info, 1);
    assert.equal(exitCodeFor(report), EXIT.ok);
    const f = report.findings[0];
    assert.equal(f.code, 'category-repeated');
    if (f.code !== 'category-repeated') return;
    assert.deepEqual(f.therapistProfileIds, [5, 6]);
    assert.deepEqual(f.teacherProfileIds, [12]);
    assert.equal(f.people, 3);
    assert.deepEqual(f.sharedEmployeeIds, []);
});

test('a CONFIRMED shared employee_id says three profiles are two people', () => {
    const report = analyzeOrganization({
        ...input(),
        categories: [
            category(2, 'therapist', 5, 7, { employee_id: 50 }),
            category(2, 'teacher', 12, 7, { employee_id: 50 }),
            category(2, 'therapist', 6, 7, { employee_id: 51 })
        ]
    });
    const f = report.findings[0];
    assert.equal(f.code, 'category-repeated');
    if (f.code !== 'category-repeated') return;
    assert.equal(f.people, 2);
    assert.deepEqual(f.sharedEmployeeIds, [50]);
});

test('without employee_id the person count is UNAVAILABLE, not zero', () => {
    const report = analyzeOrganization({
        ...input({ capabilities: { employees: false, employeeRoles: false, profileEmployeeId: false, categories: true } }),
        categories: [category(2, 'therapist', 5, 7), category(2, 'teacher', 12, 7)]
    });
    const f = report.findings[0];
    assert.equal(f.code, 'category-repeated');
    if (f.code !== 'category-repeated') return;
    assert.equal(f.people, null);
    assert.notEqual(f.people, 0);
    assert.equal(report.years[1].categoryPeople, null);
    assert.equal(report.years[1].employeesWithExtraRoles, null);
});

// ── the schema probe, on 036 and on 032 ────────────────────────────────────

type FakeData = {
    probe?: Record<string, unknown>;
    years?: YearRow[];
    homerooms?: any[];
    categories?: any[];
    employeeRoles?: any[];
    capture?: string[];
    fail?: Error;
};

const probe036 = {
    database: 'invented_db',
    has_school_years: true,
    has_teacher_classes: true,
    has_teacher_years: true,
    has_therapist_years: true,
    has_employees: true,
    has_employee_roles: true,
    has_categories: true,
    has_migrations: true,
    teacher_employee_id: true,
    therapist_employee_id: true,
    teacher_category: true,
    therapist_category: true
};
const probe032 = { ...probe036, has_employees: false, has_employee_roles: false, teacher_employee_id: false, therapist_employee_id: false };

function fake(data: FakeData = {}) {
    return async (sql: string) => {
        data.capture?.push(sql);
        if (data.fail) throw data.fail;
        if (sql.includes('current_database()')) return { rows: [data.probe ?? probe036] };
        if (sql.includes('FROM schema_migrations')) return { rows: [{ n: 36, latest: '036_workspace_api_privacy.sql' }] };
        if (sql.includes('FROM school_years')) return { rows: data.years ?? YEARS };
        if (sql.includes('FROM teacher_classes')) return { rows: data.homerooms ?? [] };
        if (sql.includes('FROM employee_roles')) return { rows: data.employeeRoles ?? [] };
        if (sql.includes('FROM teacher_years')) return { rows: data.categories ?? [] };
        throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    };
}

test('on schema 036 the employee link is available and the categories are read', async () => {
    const seen: string[] = [];
    const read = await readOrganization(fake({ capture: seen, categories: [category(2, 'teacher', 12, 7, { employee_id: 50 })] }));
    assert.equal(read.capabilities.profileEmployeeId, true);
    assert.equal(read.capabilities.employees, true);
    assert.equal(read.categories.length, 1);
    assert.ok(seen.some((s) => s.includes('FROM employee_roles')));
    assert.ok(seen.some((s) => s.includes('t.employee_id')), 'the category read must carry the confirmed person');
});

test('on schema 032 the same read works and refuses to invent the employee link', async () => {
    const seen: string[] = [];
    const read = await readOrganization(fake({ capture: seen, probe: probe032, categories: [category(2, 'teacher', 12, 7)] }));
    assert.equal(read.capabilities.employees, false);
    assert.equal(read.capabilities.profileEmployeeId, false);
    assert.equal(read.capabilities.categories, true, 'category_id predates employees and is still readable');
    assert.equal(read.employeeRoles.length, 0);
    assert.ok(!seen.some((s) => s.includes('FROM employee_roles')), 'a table that does not exist is not queried');
    assert.ok(seen.some((s) => s.includes('NULL::integer')), 'the missing column is read as NULL, not as 0');
});

test('the probe asks about THIS search_path, the way a statement would', async () => {
    const seen: string[] = [];
    await readOrganization(fake({ capture: seen }));
    const probe = seen[0];
    assert.match(probe, /to_regclass\('employees'\)/);
    assert.match(probe, /attrelid = to_regclass\('teachers'\)/);
    assert.ok(!/pg_tables|information_schema/.test(probe), 'those answer for the whole database, not for this schema');
});

test('a failed connection is an operational error, never a clean result', async () => {
    await assert.rejects(
        readOrganization(fake({ fail: new Error('connection refused') })),
        (error: unknown) => error instanceof OrganizationReadError
    );
});

test('operational failures never print raw connection errors or private values', async () => {
    const secret = 'postgres://private-user:private-password@host/private-db';
    const failure = Object.assign(new Error(secret), { code: 'ECONNREFUSED' });
    assert.equal(safeOrganizationError(failure), 'Database operation failed (ECONNREFUSED).');
    assert.ok(!safeOrganizationError(new Error(secret)).includes(secret));
    assert.ok(!safeOrganizationError({ code: secret }).includes(secret));
    await assert.rejects(readOrganization(fake({ fail: failure })), (error: unknown) => {
        assert.ok(error instanceof OrganizationReadError);
        assert.ok(!String(error).includes(secret));
        return true;
    });
});

test('unavailable categories or migration ledger cannot masquerade as zero findings', async () => {
    for (const field of ['has_categories', 'teacher_category', 'therapist_category', 'has_migrations']) {
        await assert.rejects(readOrganization(fake({ probe: { ...probe036, [field]: false } })), OrganizationReadError);
    }
});

test('a missing table stops the read instead of reporting an empty school', async () => {
    await assert.rejects(
        readOrganization(fake({ probe: { ...probe036, has_teacher_classes: false } })),
        (error: unknown) => error instanceof OrganizationReadError && /teacher_classes/.test(String(error))
    );
});

test('a database with no school year is operational, not clean', async () => {
    await assert.rejects(
        readOrganization(fake({ years: [] })),
        (error: unknown) => error instanceof OrganizationReadError
    );
});

// ── the report itself ──────────────────────────────────────────────────────

test('the report carries installation, database, schema and ids — and no names', () => {
    const data = input({
        homerooms: [homeroom(2, 10, 100), homeroom(2, 11, 100)],
        categories: [category(2, 'therapist', 5, 7, { employee_id: 50 }), category(2, 'teacher', 12, 7, { employee_id: 50 })]
    });
    const text = formatOrganizationReport(data, analyzeOrganization(data), {
        id: 'home',
        label: 'ДОМА · ZenPC'
    }).join('\n');
    assert.match(text, /invented_db/);
    assert.match(text, /036_workspace_api_privacy\.sql/);
    assert.match(text, /2026\/2027/);
    assert.match(text, /паралелка #100/);
    assert.match(text, /исто лице низ повеќе профили: 50/);
    assert.ok(!/postgres:\/\//.test(text), 'a connection string must never reach the report');
});

test('an unavailable fact is printed as unavailable, not as 0', () => {
    const data = input({
        capabilities: { employees: false, employeeRoles: false, profileEmployeeId: false, categories: true },
        categories: [category(2, 'therapist', 5, 7), category(2, 'teacher', 12, 7)]
    });
    const text = formatOrganizationReport(data, analyzeOrganization(data), { id: 'home', label: 'ДОМА · ZenPC' }).join('\n');
    assert.match(text, /лица: недостапно/);
    assert.ok(!/лица: 0/.test(text));
});
