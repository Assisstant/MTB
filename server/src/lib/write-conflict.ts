/** Conflicts which must keep the caller's draft and ask for a fresh read. */
export const MERGED_PUPIL_MESSAGE = 'Ученикот е споен со друг запис. Внесот не е зачуван. Освежете го списокот, проверете го ученикот и обидете се повторно.';

export function writeConflict(error: any): { error: string; mergedPupil?: boolean } | null {
    if (error?.constraint === 'students_merged_reference') {
        return { error: MERGED_PUPIL_MESSAGE, mergedPupil: true };
    }
    if (['40001', '40P01'].includes(error?.code)) {
        return { error: 'Податоците се менуваат во друг прозорец. Внесот не е зачуван. Освежете, споредете и обидете се повторно.' };
    }
    return null;
}
