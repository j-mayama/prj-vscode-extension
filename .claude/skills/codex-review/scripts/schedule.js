'use strict';

/**
 * Decides from the local clock whether right now is work time or away time.
 *
 * The mode is derived on every call rather than stored. Writing it down would
 * mean something has to write it back on Monday morning, and the failure mode of
 * that — a weekend switch that never flips back — is unattended edits landing
 * silently in the middle of a working day.
 *
 * Away time is everything outside `workdays` × `[start, end)` in the machine's
 * own timezone: evenings, weekends, holidays taken as days off.
 */

const DEFAULTS = {
  enabled: false,
  workdays: [1, 2, 3, 4, 5], // 0 = 日曜
  start: '09:00',
  end: '18:00',
};

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** "HH:MM" → minutes since midnight. Returns null when unparseable. */
function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function settings(config) {
  return { ...DEFAULTS, ...(config?.schedule ?? {}) };
}

/**
 * Returns { mode, reason, schedule }.
 *   mode 'work' | 'away' | null   null means scheduling is off — the caller
 *                                 should fall back to explicit settings.
 */
function currentMode(config, now = new Date()) {
  const s = settings(config);
  if (s.enabled === false) return { mode: null, reason: 'スケジュール判定は無効', schedule: s };
  if (s.enabled !== true) {
    return { mode: 'work', reason: 'schedule.enabled が不正なため通常モード扱い', schedule: s };
  }

  const start = parseHM(s.start);
  const end = parseHM(s.end);
  if (start === null || end === null || start >= end) {
    // A broken window must not silently promote every turn to unattended.
    return { mode: 'work', reason: `勤務時間の指定が不正（${s.start}〜${s.end}）のため通常モード扱い`, schedule: s };
  }
  if (
    !Array.isArray(s.workdays) ||
    s.workdays.length === 0 ||
    s.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(s.workdays).size !== s.workdays.length
  ) {
    return { mode: 'work', reason: '勤務日の指定が不正なため通常モード扱い', schedule: s };
  }

  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const isWorkday = s.workdays.includes(day);
  const inHours = minutes >= start && minutes < end;
  const clock = `${DAY_NAMES[day]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (isWorkday && inHours) {
    return { mode: 'work', reason: `${clock} は勤務時間内（${s.start}〜${s.end}）`, schedule: s };
  }
  const why = !isWorkday ? `${clock} は勤務日ではない` : `${clock} は勤務時間外（${s.start}〜${s.end}）`;
  return { mode: 'away', reason: why, schedule: s };
}

module.exports = { currentMode, settings, parseHM, DEFAULTS, DAY_NAMES };
