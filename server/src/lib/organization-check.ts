/**
 * Preflight reading for the organisation model: who leads a class, and which
 * professional category a profile holds, across EVERY school year.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here writes, and nothing here infers an
 * identity. Two profiles are the same person only when the database already
 * says so through `employees.id` (migration 035); equal names are not evidence
 * (rule 2), and on a schema without that column the answer is `null` — not 0.
 * Reporting an unavailable fact as zero is how a preflight turns into a claim
 * it cannot support.
 *
 * WHY THE READING IS SPLIT FROM THE SQL. `analyzeOrganization` is a pure
 * function over rows, so the whole rule set is testable on an invented school
 * with no database at all; `readOrganization` takes a query function, so a
 * failing connection and a schema that predates `employees` are testable the
 * same way. The script does the transaction and the printing, and no logic.
 *
 * WHAT IS A FINDING AND WHAT IS NOT.
 *   fault  a class with two homeroom teachers, or a teacher holding homeroom
 *          in two classes in the same year. Both contradict the school's own
 *          model inside a single year, and they are reported for archived
 *          years too — an archived contradiction is a fact about a year that
 *          has to keep reading correctly, not something to sweep.
 *   info   the same category held by several profiles. That is NORMAL: a
 *          profession is not a room, several people are logopedists, and a
 *          repeated category is not a fault. It is printed with numbers so the
 *          exclusivity question can be DECIDED later instead of assumed now.
 */

export type OrganizationCapabilities = {
    /** migration 035: `employees`, and therefore a confirmed person behind two profiles */
    employees: boolean;
    employeeRoles: boolean;
    /** both `teachers.employee_id` and `therapists.employee_id` resolvable in this search_path */
    profileEmployeeId: boolean;
    /** migration 024: `specialist_categories` and the annual `category_id` columns */
    categories: boolean;
};

export type YearRow = { id: number; label: string; is_current: boolean };

export type HomeroomRow = {
    year_id: number;
    teacher_id: number;
    class_id: number;
    teacher_listed: boolean;
    teacher_active: boolean;
    class_listed: boolean;
    class_active: boolean;
};

export type CategoryRow = {
    profile_kind: 'teacher' | 'therapist';
    year_id: number;
    profile_id: number;
    category_id: number;
    active: boolean;
    /** null on a schema without `employees`, and null is not zero */
    employee_id: number | null;
};

export type EmployeeRoleRow = { year_id: number; employee_id: number; role: string; active: boolean };

export type OrganizationInput = {
    database: string;
    migrations: { count: number; latest: string | null };
    capabilities: OrganizationCapabilities;
    years: YearRow[];
    homerooms: HomeroomRow[];
    categories: CategoryRow[];
    employeeRoles: EmployeeRoleRow[];
};

export type YearRef = { id: number; label: string; current: boolean };

export type Finding =
    | {
          code: 'class-multiple-homerooms';
          level: 'fault';
          year: YearRef;
          classId: number;
          teacherIds: number[];
          activeTeacherIds: number[];
      }
    | {
          code: 'teacher-multiple-homerooms';
          level: 'fault';
          year: YearRef;
          teacherId: number;
          classIds: number[];
          activeClassIds: number[];
      }
    | {
          code: 'category-repeated';
          level: 'info';
          year: YearRef;
          categoryId: number;
          teacherProfileIds: number[];
          therapistProfileIds: number[];
          activeProfiles: number;
          /** distinct confirmed people behind those profiles, or null when unavailable */
          people: number | null;
          /** employee ids carrying the category through MORE THAN ONE profile */
          sharedEmployeeIds: number[];
      };

export type YearSummary = {
    year: YearRef;
    homeroomAssignments: number;
    classesWithHomeroom: number;
    categoryAssignments: number;
    activeCategoryAssignments: number;
    /** confirmed people holding any category this year, or null when unavailable */
    categoryPeople: number | null;
    employeesWithExtraRoles: number | null;
};

export type OrganizationReport = {
    findings: Finding[];
    faults: number;
    info: number;
    years: YearSummary[];
};

/** 0 the read succeeded and no homeroom finding stands; 1 a homeroom finding; 2 an operational failure. */
export const EXIT = { ok: 0, finding: 1, operational: 2 } as const;

/** The tables this check cannot work without; a missing one is operational, never "no findings". */
export const REQUIRED_TABLES = ['school_years', 'teacher_classes', 'teacher_years', 'therapist_years'] as const;

/** Thrown for anything that stopped the READ; the caller reports it as operational, not as a clean result. */
export class OrganizationReadError extends Error {}

/** Driver messages can contain connection strings, usernames or private values. */
export function safeOrganizationError(error: unknown): string {
    if (error instanceof OrganizationReadError) return error.message;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const safeCode = typeof code === 'string' && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)$/.test(code)
        ? ` (${code})` : '';
    return `Database operation failed${safeCode}.`;
}

const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const k = key(row);
        const bucket = out.get(k);
        if (bucket) bucket.push(row);
        else out.set(k, [row]);
    }
    return out;
}

export function analyzeOrganization(input: OrganizationInput): OrganizationReport {
    const years = new Map(input.years.map((y) => [y.id, y]));
    const yearRef = (id: number): YearRef => {
        const found = years.get(id);
        return { id, label: found?.label ?? `#${id}`, current: found?.is_current ?? false };
    };
    const findings: Finding[] = [];

    for (const [, rows] of groupBy(input.homerooms, (r) => `${r.year_id}|${r.class_id}`)) {
        const teacherIds = uniqueSorted(rows.map((r) => r.teacher_id));
        if (teacherIds.length < 2) continue;
        findings.push({
            code: 'class-multiple-homerooms',
            level: 'fault',
            year: yearRef(rows[0].year_id),
            classId: rows[0].class_id,
            teacherIds,
            activeTeacherIds: uniqueSorted(rows.filter((r) => r.teacher_active).map((r) => r.teacher_id))
        });
    }

    for (const [, rows] of groupBy(input.homerooms, (r) => `${r.year_id}|${r.teacher_id}`)) {
        const classIds = uniqueSorted(rows.map((r) => r.class_id));
        if (classIds.length < 2) continue;
        findings.push({
            code: 'teacher-multiple-homerooms',
            level: 'fault',
            year: yearRef(rows[0].year_id),
            teacherId: rows[0].teacher_id,
            classIds,
            activeClassIds: uniqueSorted(rows.filter((r) => r.class_active).map((r) => r.class_id))
        });
    }

    for (const [, rows] of groupBy(input.categories, (r) => `${r.year_id}|${r.category_id}`)) {
        if (rows.length < 2) continue;
        const linked = rows.filter((r) => r.employee_id != null);
        const perEmployee = groupBy(linked, (r) => String(r.employee_id));
        findings.push({
            code: 'category-repeated',
            level: 'info',
            year: yearRef(rows[0].year_id),
            categoryId: rows[0].category_id,
            teacherProfileIds: uniqueSorted(rows.filter((r) => r.profile_kind === 'teacher').map((r) => r.profile_id)),
            therapistProfileIds: uniqueSorted(rows.filter((r) => r.profile_kind === 'therapist').map((r) => r.profile_id)),
            activeProfiles: rows.filter((r) => r.active).length,
            // Unavailable is null, not 0: on a schema without `employees` nothing
            // here may claim how many PEOPLE those profiles are.
            people: input.capabilities.profileEmployeeId ? new Set(linked.map((r) => r.employee_id as number)).size : null,
            sharedEmployeeIds: input.capabilities.profileEmployeeId
                ? uniqueSorted([...perEmployee].filter(([, r]) => r.length > 1).map(([id]) => Number(id)))
                : []
        });
    }

    // Ordered by year label so an archived year is never hidden behind the
    // current one; both are printed and both count.
    findings.sort((a, b) => a.year.label.localeCompare(b.year.label) || a.year.id - b.year.id);

    const summaries: YearSummary[] = input.years.map((year) => {
        const homerooms = input.homerooms.filter((r) => r.year_id === year.id);
        const categories = input.categories.filter((r) => r.year_id === year.id);
        const people = categories.map((r) => r.employee_id).filter((id): id is number => id != null);
        const roles = input.employeeRoles.filter((r) => r.year_id === year.id && r.active);
        return {
            year: { id: year.id, label: year.label, current: year.is_current },
            homeroomAssignments: homerooms.length,
            classesWithHomeroom: new Set(homerooms.map((r) => r.class_id)).size,
            categoryAssignments: categories.length,
            activeCategoryAssignments: categories.filter((r) => r.active).length,
            categoryPeople: input.capabilities.profileEmployeeId ? new Set(people).size : null,
            employeesWithExtraRoles: input.capabilities.employeeRoles
                ? new Set(roles.map((r) => r.employee_id)).size
                : null
        };
    });

    return {
        findings,
        faults: findings.filter((f) => f.level === 'fault').length,
        info: findings.filter((f) => f.level === 'info').length,
        years: summaries
    };
}

/** A repeated profession alone is never a failure — only a homeroom contradiction is. */
export function exitCodeFor(report: OrganizationReport): number {
    return report.faults ? EXIT.finding : EXIT.ok;
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/**
 * Every SQL statement the check makes. The caller supplies the query function,
 * so the transaction, the isolation level and the connection belong to the
 * script — and a test can hand it a fake schema or a connection that throws.
 */
export async function readOrganization(query: QueryFn): Promise<OrganizationInput> {
    const run = async (sql: string, params: unknown[] = []) => {
        try {
            return (await query(sql, params)).rows as any[];
        } catch (error) {
            throw new OrganizationReadError(safeOrganizationError(error));
        }
    };

    // to_regclass and conrelid-style lookups resolve through THIS search_path,
    // exactly as a statement would. `pg_tables` answers for the whole database
    // and has already caused a migration guard to read another schema's copy.
    const attribute = (table: string, column: string) =>
        `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('${table}')
                  AND attname = '${column}' AND NOT attisdropped AND attnum > 0)`;
    const [probe] = await run(
        `SELECT current_database() AS database,
                ${REQUIRED_TABLES.map((t) => `to_regclass('${t}') IS NOT NULL AS has_${t}`).join(',\n                ')},
                to_regclass('employees')            IS NOT NULL AS has_employees,
                to_regclass('employee_roles')       IS NOT NULL AS has_employee_roles,
                to_regclass('specialist_categories') IS NOT NULL AS has_categories,
                to_regclass('schema_migrations')    IS NOT NULL AS has_migrations,
                ${attribute('teachers', 'employee_id')}   AS teacher_employee_id,
                ${attribute('therapists', 'employee_id')} AS therapist_employee_id,
                ${attribute('teacher_years', 'category_id')}   AS teacher_category,
                ${attribute('therapist_years', 'category_id')} AS therapist_category`
    );
    if (!probe) throw new OrganizationReadError('Базата не одговори на почетното читање на шемата.');

    const missing = REQUIRED_TABLES.filter((t) => !probe[`has_${t}`]);
    if (missing.length) {
        throw new OrganizationReadError(
            `Недостасуваат табели во тековниот search_path: ${missing.join(', ')}. ` +
                'Ова не е „нема неправилности" — читањето воопшто не се изврши.'
        );
    }

    const capabilities: OrganizationCapabilities = {
        employees: Boolean(probe.has_employees),
        employeeRoles: Boolean(probe.has_employee_roles),
        profileEmployeeId: Boolean(probe.has_employees && probe.teacher_employee_id && probe.therapist_employee_id),
        categories: Boolean(probe.has_categories && probe.teacher_category && probe.therapist_category)
    };

    // Both supported schemas (032 and 036) have these. Missing is not zero.
    if (!capabilities.categories || !probe.has_migrations) {
        throw new OrganizationReadError('Недостапен каталог на категории или schema_migrations; проверката не е целосна.');
    }

    const migrations = probe.has_migrations
        ? ((await run('SELECT count(*)::int AS n, max(filename) AS latest FROM schema_migrations'))[0] ?? {
              n: 0,
              latest: null
          })
        : { n: 0, latest: null };

    const years = (await run('SELECT id, label, is_current FROM school_years ORDER BY label, id')) as YearRow[];
    if (!years.length) throw new OrganizationReadError('Нема ниту една учебна година во базата.');

    // Activity is a fact of the YEAR (`*_years.active`); `teacher_classes` has
    // none of its own. A homeroom row whose teacher is not on the year's list
    // is still reported — it is carried with its flags rather than filtered
    // away, because a filtered row is one nobody is told about.
    const homerooms = (await run(
        `SELECT tc.school_year_id AS year_id, tc.teacher_id, tc.class_id,
                (ty.teacher_id IS NOT NULL)      AS teacher_listed,
                coalesce(ty.active, false)       AS teacher_active,
                (cy.class_id IS NOT NULL)        AS class_listed,
                coalesce(cy.active, false)       AS class_active
           FROM teacher_classes tc
           LEFT JOIN teacher_years ty
                  ON ty.school_year_id = tc.school_year_id AND ty.teacher_id = tc.teacher_id
           LEFT JOIN class_years cy
                  ON cy.school_year_id = tc.school_year_id AND cy.class_id = tc.class_id
          WHERE tc.role = 'homeroom'
          ORDER BY tc.school_year_id, tc.class_id, tc.teacher_id`
    )) as HomeroomRow[];

    const employeeColumn = (table: string) => (capabilities.profileEmployeeId ? `${table}.employee_id` : 'NULL::integer');
    const categories = capabilities.categories
        ? ((await run(
              `SELECT 'teacher' AS profile_kind, ty.school_year_id AS year_id, ty.teacher_id AS profile_id,
                      ty.category_id, ty.active, ${employeeColumn('t')} AS employee_id
                 FROM teacher_years ty JOIN teachers t ON t.id = ty.teacher_id
                WHERE ty.category_id IS NOT NULL
                UNION ALL
               SELECT 'therapist', ry.school_year_id, ry.therapist_id,
                      ry.category_id, ry.active, ${employeeColumn('r')}
                 FROM therapist_years ry JOIN therapists r ON r.id = ry.therapist_id
                WHERE ry.category_id IS NOT NULL
                ORDER BY 2, 4, 1, 3`
          )) as CategoryRow[])
        : [];

    const employeeRoles = capabilities.employeeRoles
        ? ((await run(
              `SELECT school_year_id AS year_id, employee_id, role, active FROM employee_roles
                ORDER BY school_year_id, employee_id, role`
          )) as EmployeeRoleRow[])
        : [];

    return {
        database: String(probe.database ?? ''),
        migrations: { count: Number(migrations.n ?? 0), latest: migrations.latest ?? null },
        capabilities,
        years,
        homerooms,
        categories,
        employeeRoles
    };
}

const yes = (value: boolean) => (value ? 'да' : 'не');
const orUnknown = (value: number | null, missing: string) => (value == null ? missing : String(value));

/** The report. Technical ids only: no names, no credentials, no DATABASE_URL. */
export function formatOrganizationReport(
    input: OrganizationInput,
    report: OrganizationReport,
    installation: { id: string; label: string; warning?: string }
): string[] {
    const out: string[] = [];
    const unavailable = 'недостапно (шема без employee_id)';

    out.push('');
    out.push('════ ПРЕДПРОВЕРКА НА ОРГАНИЗАЦИСКИОТ МОДЕЛ (само читање) ════');
    out.push(`  инсталација:     ${installation.id} · ${installation.label}`);
    if (installation.warning) out.push(`  ⚠ ${installation.warning}`);
    out.push(`  база:            ${input.database}`);
    out.push(`  миграции:        ${input.migrations.count}${input.migrations.latest ? ` · последна ${input.migrations.latest}` : ''}`);
    out.push(
        `  достапност:      employees=${yes(input.capabilities.employees)} · ` +
            `employee_id на профилите=${yes(input.capabilities.profileEmployeeId)} · ` +
            `employee_roles=${yes(input.capabilities.employeeRoles)} · ` +
            `категории=${yes(input.capabilities.categories)}`
    );
    if (!input.capabilities.profileEmployeeId) {
        out.push('  ⓘ На оваа шема поврзувањето наставник↔терапевт преку employee_id НЕ е достапно.');
        out.push('    Затоа „лица" се пријавува како недостапно, а не како нула. Еднакви имиња');
        out.push('    не се доказ дека станува збор за исто лице.');
    }

    out.push('');
    out.push(`──── ГОДИНИ (${report.years.length}) ────`);
    for (const y of report.years) {
        out.push(
            `  ${y.year.label}${y.year.current ? ' (тековна)' : ''}  #${y.year.id}` +
                `  раководства: ${y.homeroomAssignments} во ${y.classesWithHomeroom} паралелки` +
                `  ·  категории: ${y.categoryAssignments} (активни ${y.activeCategoryAssignments})` +
                `  ·  лица со категорија: ${orUnknown(y.categoryPeople, unavailable)}` +
                `  ·  вработени со дополнителна улога: ${orUnknown(y.employeesWithExtraRoles, 'недостапно (шема без employee_roles)')}`
        );
    }

    const faults = report.findings.filter((f) => f.level === 'fault');
    out.push('');
    out.push(`──── НАОДИ ЗА РАКОВОДСТВО (${faults.length}) ────`);
    if (!faults.length) out.push('  нема');
    for (const f of faults) {
        const where = `${f.year.label}${f.year.current ? '' : ' · архивска'}`;
        if (f.code === 'class-multiple-homerooms') {
            out.push(
                `  ✗ ${where}: паралелка #${f.classId} има ${f.teacherIds.length} раководители ` +
                    `(наставници ${f.teacherIds.join(', ')}; активни во годината: ${f.activeTeacherIds.join(', ') || 'ниту еден'})`
            );
        } else if (f.code === 'teacher-multiple-homerooms') {
            out.push(
                `  ✗ ${where}: наставник #${f.teacherId} е раководител на ${f.classIds.length} паралелки ` +
                    `(${f.classIds.join(', ')}; активни паралелки: ${f.activeClassIds.join(', ') || 'ниту една'})`
            );
        }
    }

    const info = report.findings.filter((f) => f.level === 'info');
    out.push('');
    out.push(`──── ПОВТОРЕНА КАТЕГОРИЈА — ИНФОРМАТИВНО, НЕ ГРЕШКА (${info.length}) ────`);
    out.push('  Професија не е кабинет. Повеќе лица смеат да ја имаат истата категорија;');
    out.push('  ова се брои за да може ексклузивноста да се ОДЛУЧИ, не за да се претпостави.');
    if (!info.length) out.push('  нема');
    for (const f of info) {
        if (f.code !== 'category-repeated') continue;
        out.push(
            `  • ${f.year.label}${f.year.current ? '' : ' · архивска'}: категорија #${f.categoryId} — ` +
                `наставнички профили [${f.teacherProfileIds.join(', ') || '—'}] · ` +
                `терапевтски профили [${f.therapistProfileIds.join(', ') || '—'}] · ` +
                `активни профили: ${f.activeProfiles} · лица: ${orUnknown(f.people, unavailable)}` +
                (f.sharedEmployeeIds.length ? ` · исто лице низ повеќе профили: ${f.sharedEmployeeIds.join(', ')}` : '')
        );
    }

    out.push('');
    out.push('Излезни кодови: 0 прочитано без наод · 1 наод за раководство · 2 оперативна грешка.');
    out.push('Оваа алатка не пишува: нема --apply, DDL, backfill ниту поврзување лица.');
    out.push('');
    return out;
}
