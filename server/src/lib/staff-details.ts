/** Annual directory facts. Neither profession nor duty grants a schedule role. */
export const STAFF_PROFESSIONS = {
    unknown: 'Непотврдено', teacher: 'Наставник', spec_edukator: 'Специјален едукатор / дефектолог',
    logoped: 'Логопед', psiholog: 'Психолог', pedagog: 'Педагог', vospituvac: 'Воспитувач',
    socijalen_rabotnik: 'Социјален работник', other: 'Друго'
} as const;
export const STAFF_DUTIES = {
    teaching: 'Настава', modified_teaching: 'Настава · модифицирана програма (и со надворешни)',
    preparatory_group: 'Групна рехабилитација · подготвителна',
    individual_rehabilitation: 'Индивидуална рехабилитација',
    counselling: 'Советодавна работа', assistant_coordination: 'Координација на образовни асистенти',
    mentoring: 'Менторство', administration: 'Администрација', boarding: 'Воспитна работа / интернат'
} as const;
