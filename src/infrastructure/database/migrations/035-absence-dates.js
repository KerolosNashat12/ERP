/**
 * "لو عاوز اقول هي غابت انهي يوم بالظبط" — one nullable column: `costs.absence_dates`,
 * the specific dates behind an absence deduction rather than just a count.
 *
 * `absence_days` (migration 034) still carries the count and still works on
 * its own for anything that never sends dates — this is additive, not a
 * replacement. When dates ARE sent, `PayrollService#breakdown` derives the
 * count from them instead of trusting a separately-typed number, and stores
 * the canonical sorted comma list here for the record.
 */
export default {
  name: '035-absence-dates',

  async up({ hasColumn, addColumn }) {
    if (!await hasColumn('costs', 'absence_dates')) {
      await addColumn('costs', 'absence_dates', 'TEXT');
    }
  },
};
