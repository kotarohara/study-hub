// Pure helpers for the project roll-up calendar (spec §3.7).

export interface MonthRef {
  year: number;
  /** 1–12 */
  month: number;
}

export function parseMonthParam(raw: string | null, fallback: Date): MonthRef {
  const match = raw?.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) return { year, month };
  }
  return {
    year: fallback.getUTCFullYear(),
    month: fallback.getUTCMonth() + 1,
  };
}

export function monthParam(ref: MonthRef): string {
  return `${ref.year}-${String(ref.month).padStart(2, "0")}`;
}

export function addMonths(ref: MonthRef, delta: number): MonthRef {
  const zero = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12 + 12) % 12 + 1 };
}

/** Weeks (Mon–Sun) covering the month; days outside the month are null. */
export function monthGrid(ref: MonthRef): (string | null)[][] {
  const first = new Date(Date.UTC(ref.year, ref.month - 1, 1));
  const daysInMonth = new Date(Date.UTC(ref.year, ref.month, 0)).getUTCDate();
  // getUTCDay: 0=Sun … 6=Sat → Monday-based offset.
  const lead = (first.getUTCDay() + 6) % 7;

  const cells: (string | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return `${ref.year}-${String(ref.month).padStart(2, "0")}-${day}`;
    }),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}
