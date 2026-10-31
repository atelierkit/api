// 内部依赖
import type { BaostockRecord } from '../source/baostock.record.js';
import { BaostockQueries } from '../source/baostock.query.js';
import { FIELD } from '../source/baostock.schema.js';
import type { ProgressSink } from './progress.js';
import type { DailyBatchDeps } from './daily-batch.js';
import type { SyncResult } from './daily-batch.js';
import type { Watermark } from './watermark.js';
import { advanceWatermark } from './watermark.js';

/** 日历同步器仓储 */
export interface CalendarStore {
  upsertCalendar(rows: CalendarRow[]): Promise<number>;
  countCalendar(): Promise<number>;
}

/** trade_calendar 的一行 */
export interface CalendarRow {
  calendarDate: string;
  isOpen: boolean;
}

/** 日历同步器依赖（读台账 / 写台账 + 数据源） */
export interface CalendarSyncerDeps {
  client: DailyBatchDeps['client'];
  store: CalendarStore;
  findWatermark(scope: string, dataset: string): Promise<Watermark | null>;
  saveWatermark(watermark: Watermark): Promise<void>;
  today(): string;
}

const PAGE_SIZE = 500;
const EARLIEST_DATE = '1990-01-01';

/**
 * 交易日历同步器（整份数据，按区间增量续期，逐页提交）
 *
 * 从「已覆盖到的最后一天 + 1」拉到「次年年底」；数据源会提前发布次年的交易日安排。
 */
export async function syncCalendar(
  deps: CalendarSyncerDeps,
  from: string | null,
  to: string | null,
  progress: ProgressSink,
): Promise<SyncResult> {
  const stage = '拉取交易日历';
  const scope = 'calendar';

  let watermark =
    (await deps.findWatermark(scope, '*')) ??
    ({ scope, dataset: '*', parameters: '', lastDate: null, rows: 0 } as Watermark);

  const start = from ?? watermark.lastDate ?? EARLIEST_DATE;
  const todayYear = new Date(`${deps.today()}T00:00:00Z`).getUTCFullYear();
  const reachThrough = Math.max(
    watermark.lastDate ? new Date(`${watermark.lastDate}T00:00:00Z`).getUTCFullYear() : 0,
    todayYear,
  );
  const upper = to ?? `${reachThrough + 1}-12-31`;

  if (start > upper) {
    return { ok: true, rowsWritten: 0, stage: `日历已覆盖至 ${watermark.lastDate}，无需拉取` };
  }

  const expectedDays = dayDiff(start, upper) + 1;
  progress.report({ stage, done: 0, total: expectedDays, fact: null });

  let fetchedDates: string[] = [];
  let writtenTotal = 0;
  let page = 1;

  while (true) {
    const records = await deps.client.query(
      BaostockQueries.tradeDates('anonymous', page, PAGE_SIZE, start, upper),
    );
    if (records.length === 0) {
      break;
    }

    const rows = records
      .map(toCalendarRow)
      .filter((r): r is CalendarRow => r !== null);
    fetchedDates.push(...rows.map((r) => r.calendarDate));

    writtenTotal += await deps.store.upsertCalendar(rows);

    const covered = fetchedDates.reduce((a, b) => (a > b ? a : b), fetchedDates[0] ?? start);
    watermark = advanceWatermark(watermark, covered, 0);
    watermark = { ...watermark, rows: await deps.store.countCalendar() };
    await deps.saveWatermark(watermark);

    progress.report({
      stage,
      done: fetchedDates.length,
      total: expectedDays,
      fact: { date: null, page, count: rows.length, elapsedMs: 0, label: null },
    });

    if (records.length < PAGE_SIZE) {
      break;
    }
    page++;
  }

  if (fetchedDates.length === 0) {
    return {
      ok: false,
      code: 'sync.calendar_empty',
      message: `数据源在 ${start} ~ ${upper} 区间没有返回任何日历记录。`,
    };
  }

  // 收敛分母到实得天数，让进度条落在 100%
  progress.report({
    stage,
    done: fetchedDates.length,
    total: fetchedDates.length,
    fact: null,
  });

  return { ok: true, rowsWritten: writtenTotal, stage: '完成' };
}

function toCalendarRow(record: BaostockRecord): CalendarRow | null {
  const date = record.get(FIELD.CALENDAR.DATE);
  if (!date || !date.trim()) {
    return null;
  }
  return {
    calendarDate: date,
    isOpen: (record.get(FIELD.CALENDAR.IS_OPEN) ?? '0') === '1',
  };
}

/** 两个 YYYY-MM-DD 的日期差（天） */
function dayDiff(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
