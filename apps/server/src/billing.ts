import type { BillingPoliciesSetInput } from "./validators";

export interface BillingPeriodCandidate {
  periodStart: Date;
  periodEnd: Date;
  label: string;
}

export interface BillingPeriodPolicy {
  recurrence: BillingPoliciesSetInput["recurrence"];
  anchorDay?: number;
  shortMonthPolicy?: "clamp_last_day" | "skip" | "rollover";
  intervalCount?: number;
  anchorDate?: Date;
  fiscalPattern?: "4-4-5" | "4-5-4" | "5-4-4";
  leapWeekPlacement?: string;
  anchorTimeOfDay?: string;
  boundaryInclusivity?: "half_open" | "inclusive" | "half_open_end";
  snapToDemandGrid?: boolean;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

function getLastDayOfMonth(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return d.getUTCDate();
}

function formatDateAsLabel(start: Date, end: Date): string {
  const startStr = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endStr = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startStr}–${endStr}`;
}

export function* materializePeriods(
  policy: BillingPeriodPolicy,
  rangeStart: Date,
  rangeEnd: Date,
  _timezone = "Africa/Johannesburg",
): Generator<BillingPeriodCandidate> {
  let current = new Date(rangeStart);

  if (policy.recurrence === "calendar_month") {
    while (current < rangeEnd) {
      const year = current.getUTCFullYear();
      const month = current.getUTCMonth();
      const nextMonth = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));

      const periodStart = current;
      const periodEnd = nextMonth > rangeEnd ? rangeEnd : nextMonth;

      yield {
        periodStart,
        periodEnd,
        label: formatDateAsLabel(periodStart, periodEnd),
      };

      current = nextMonth;
    }
  } else if (policy.recurrence === "day_of_month") {
    const anchorDay = policy.anchorDay || 1;

    while (current < rangeEnd) {
      // Determine the target month: next month if current date is on/after anchor day, else current month
      let targetMonth = current.getUTCMonth() === 11
        ? new Date(Date.UTC(current.getUTCFullYear() + 1, 0, 1))
        : new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));

      const lastDayOfTarget = getLastDayOfMonth(targetMonth);
      let day = anchorDay > lastDayOfTarget ? lastDayOfTarget : anchorDay;

      let nextStart = new Date(
        Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), day, 0, 0, 0, 0),
      );

      // Handle skip and rollover policies
      if (anchorDay > lastDayOfTarget) {
        if (policy.shortMonthPolicy === "skip") {
          // Skip to the next month with the anchor day
          targetMonth = targetMonth.getUTCMonth() === 11
            ? new Date(Date.UTC(targetMonth.getUTCFullYear() + 1, 0, 1))
            : new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 1));
          const nextLastDay = getLastDayOfMonth(targetMonth);
          day = anchorDay > nextLastDay ? nextLastDay : anchorDay;
          nextStart = new Date(
            Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), day, 0, 0, 0, 0),
          );
        } else if (policy.shortMonthPolicy === "rollover") {
          // Rollover to the 1st of the next month
          targetMonth = targetMonth.getUTCMonth() === 11
            ? new Date(Date.UTC(targetMonth.getUTCFullYear() + 1, 0, 1))
            : new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 1));
          nextStart = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), 1));
        }
      }

      if (current >= rangeEnd) break;

      const periodStart = current;
      const periodEnd = nextStart > rangeEnd ? rangeEnd : nextStart;

      yield {
        periodStart,
        periodEnd,
        label: formatDateAsLabel(periodStart, periodEnd),
      };

      current = nextStart;
    }
  } else if (policy.recurrence === "n_monthly") {
    const intervalCount = policy.intervalCount || 1;
    const anchorDate = policy.anchorDate || rangeStart;

    let periodNumber = 0;
    while (current < rangeEnd) {
      const nextStart = addMonths(anchorDate, (periodNumber + 1) * intervalCount);

      if (current >= rangeEnd) break;

      const periodStart = current;
      const periodEnd = nextStart > rangeEnd ? rangeEnd : nextStart;

      yield {
        periodStart,
        periodEnd,
        label: formatDateAsLabel(periodStart, periodEnd),
      };

      current = nextStart;
      periodNumber++;
    }
  } else if (policy.recurrence === "weekly") {
    const intervalCount = policy.intervalCount || 1;
    const anchorDate = policy.anchorDate || rangeStart;

    let weekNumber = 0;
    while (current < rangeEnd) {
      const nextStart = addWeeks(anchorDate, (weekNumber + 1) * intervalCount);

      if (current >= rangeEnd) break;

      const periodStart = current;
      const periodEnd = nextStart > rangeEnd ? rangeEnd : nextStart;

      yield {
        periodStart,
        periodEnd,
        label: formatDateAsLabel(periodStart, periodEnd),
      };

      current = nextStart;
      weekNumber++;
    }
  } else if (policy.recurrence === "fiscal") {
    const fiscalPattern = policy.fiscalPattern || "4-4-5";
    const anchorDate = policy.anchorDate || rangeStart;

    const weeksPerPeriod = fiscalPattern.split("-").map((x: string) => Number.parseInt(x));

    let fiscalYear = anchorDate.getUTCFullYear();
    let periodIndex = 0;

    while (current < rangeEnd) {
      const weeksInThisPeriod = weeksPerPeriod[periodIndex % 3] || 4;

      if (current >= rangeEnd) break;

      const periodStart = current;
      const periodEnd = addWeeks(periodStart, weeksInThisPeriod);

      yield {
        periodStart,
        periodEnd: periodEnd > rangeEnd ? rangeEnd : periodEnd,
        label: `FY${fiscalYear} P${(periodIndex % 3) + 1}`,
      };

      current = periodEnd;
      periodIndex++;

      if (periodIndex % 3 === 0) {
        fiscalYear++;
      }
    }
  } else if (policy.recurrence === "meter_read" || policy.recurrence === "manual") {
    // meter_read and manual require explicit period creation; generator yields nothing
    return;
  }
}
