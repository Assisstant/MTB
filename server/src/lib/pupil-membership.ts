import { z } from 'zod';

export const PupilDetails = {
    enrollmentType: z.enum(['internal', 'external']).optional(),
    boarding: z.boolean().optional(),
    programme: z.enum(['standard', 'modified', 'unknown']).optional(),
    placement: z.enum(['regular', 'preparatory', 'observation', 'none', 'unknown']).optional()
};

/** The state actually displayed by an editor, not a timestamp guessed from a save. */
export const ExpectedEnrollment = z.object({
    grade: z.string().max(40).nullable(),
    oddelenie: z.string().max(40).nullable(),
    kind: z.enum(['internal', 'boarding', 'external']),
    active: z.boolean(),
    enrollmentType: z.enum(['internal', 'external']),
    boarding: z.boolean(),
    programme: z.enum(['standard', 'modified', 'unknown']),
    placement: z.enum(['regular', 'preparatory', 'observation', 'none', 'unknown'])
});

export function enrollmentState(row: any): z.infer<typeof ExpectedEnrollment> {
    return {
        grade: row.grade, oddelenie: row.oddelenie, kind: row.kind, active: row.active,
        enrollmentType: row.enrollment_type, boarding: row.boarding,
        programme: row.programme, placement: row.placement
    };
}

export function sameEnrollment(expected: z.infer<typeof ExpectedEnrollment>, row: any): boolean {
    const actual = enrollmentState(row);
    return Object.keys(actual).every((key) => actual[key as keyof typeof actual] === expected[key as keyof typeof expected]);
}

export function hasPupilDetails(body: Record<string, unknown>): boolean {
    return Object.keys(PupilDetails).some((key) => body[key] !== undefined);
}

export function resolvedDetails(body: Record<string, any>, previous?: any) {
    const explicitKind = body.kind;
    const enrollmentType = body.enrollmentType ?? (explicitKind ? (explicitKind === 'external' ? 'external' : 'internal') : previous?.enrollment_type ?? 'internal');
    const boarding = body.boarding ?? (explicitKind ? explicitKind === 'boarding' : previous?.boarding ?? false);
    return {
        enrollmentType, boarding,
        kind: enrollmentType === 'external' ? 'external' : boarding ? 'boarding' : 'internal',
        programme: body.programme ?? previous?.programme ?? 'unknown',
        placement: body.placement ?? previous?.placement ?? 'unknown'
    };
}

export function pupilDetailsProblem(details: ReturnType<typeof resolvedDetails>, grade: string | null, assignmentChanged: boolean): string | null {
    if (details.enrollmentType === 'external' && details.boarding) return 'Интернат може да користи само внатрешен ученик.';
    if (details.placement === 'none' && grade) return 'Ученик без локална настава не може да има локална паралелка.';
    if (assignmentChanged && grade && details.enrollmentType === 'external'
        && details.programme !== 'modified' && !['preparatory', 'observation'].includes(details.placement)) {
        return 'Пред паралелка за надворешен ученик, изберете модифицирана програма, подготвителна група или опсервација.';
    }
    return null;
}

export async function validAnnualClass(client: any, yearId: number, grade: string | null): Promise<boolean> {
    if (!grade) return true;
    const { rows } = await client.query(
        `SELECT 1 FROM school_classes c JOIN class_years cy ON cy.class_id = c.id
         WHERE c.label = $1 AND cy.school_year_id = $2 AND cy.active`, [grade, yearId]
    );
    return rows.length > 0;
}
