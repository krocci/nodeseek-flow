export const ATTENDANCE_COOLDOWN_MS = 30 * 60 * 1000;
export const ATTENDANCE_LOCK = 'nodeseek-flow:attendance';

export type AttendanceRecord = { createdAt: string; gain?: number };
export type AttendanceState = {
  account: string;
  day: string;
  status: 'pending' | 'failed' | 'signed';
  checkedAt: number;
  nextAttempt: number;
  gain?: number;
  message?: string;
};
export type AttendanceResult = {
  status: 'skipped' | 'busy' | 'cooldown' | 'signed' | 'failed';
  state?: AttendanceState;
};

export interface AttendanceDeps {
  now(): number;
  readEnabled(): Promise<boolean>;
  currentAccount(): string | null;
  isVisible(): boolean;
  // Main-background RPC only. Resolve writes after durable storage acknowledgement.
  readState(account: string): Promise<AttendanceState | null>;
  writeState(account: string, state: AttendanceState): Promise<void>;
  // One extension-wide lock across ALL accounts/tabs. Return undefined if busy.
  // Keep ownership until work settles; claim/finish RPC adapters must release in
  // finally and must not allow an expired lease owner to continue running work.
  withLock<T>(key: string, work: () => Promise<T>): Promise<T | undefined>;
  // forumFetch adapters must enforce request timeouts, reject HTTP/auth/parse
  // errors, and never retry POST. Board null means a validated response with no
  // current-account record (never infer it from malformed or unknown JSON).
  getBoard(account: string): Promise<AttendanceRecord | null>;
  // success must represent explicit server confirmation, including already signed.
  // No reward is inferred from success or from a message.
  post(account: string, options: { random: false }): Promise<{ success: boolean }>;
}

export function attendanceDay(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Passive engine: caller schedules scans; there are no timers or automatic retries. */
export function createAttendance(deps: AttendanceDeps) {
  let busy = false;
  const local = new Map<string, AttendanceState>();
  let unavailableUntil = 0;

  async function eligible(account: string, day: string): Promise<boolean> {
    const enabled = await deps.readEnabled();
    return (
      enabled === true &&
      deps.isVisible() &&
      deps.currentAccount() === account &&
      attendanceDay(deps.now()) === day
    );
  }

  async function run(account: string): Promise<AttendanceResult> {
    const day = attendanceDay(deps.now());
    if (!(await eligible(account, day))) return { status: 'skipped' };
    const saved = await deps.readState(account);
    for (const state of [saved, local.get(account)]) {
      if (!state || state.account !== account) continue;
      if (state.day === day && state.status === 'signed') return { status: 'signed', state };
      // Cooldowns cross midnight; uncertain late-night requests remain guarded.
      if (state.nextAttempt > deps.now()) return { status: 'cooldown', state };
    }
    const state: AttendanceState = {
      account,
      day,
      status: 'pending',
      checkedAt: deps.now(),
      nextAttempt: deps.now() + ATTENDANCE_COOLDOWN_MS,
    };
    const save = async () => {
      local.set(account, { ...state });
      await deps.writeState(account, { ...state });
    };
    // A crash, lost RPC reply, or ambiguous POST leaves a durable guard.
    // If this write fails, no network request is allowed.
    await save();
    try {
      if (!(await eligible(account, day))) return { status: 'skipped' };
      const record = await deps.getBoard(account);
      if (
        record !== null &&
        (!record ||
          typeof record.createdAt !== 'string' ||
          !/(?:Z|[+-]\d{2}:\d{2})$/i.test(record.createdAt) ||
          !Number.isFinite(Date.parse(record.createdAt)))
      ) {
        throw new Error('签到记录时间格式无效，未提交签到');
      }
      const signed = record !== null && attendanceDay(Date.parse(record.createdAt)) === day;
      if (!signed) {
        // Refresh the durable guard after a potentially slow board request.
        state.checkedAt = deps.now();
        state.nextAttempt = deps.now() + ATTENDANCE_COOLDOWN_MS;
        await save();
        // No awaited work between this check and the POST invocation.
        if (!(await eligible(account, day))) return { status: 'skipped' };
        const response = await deps.post(account, { random: false });
        if (response?.success !== true) throw new Error('服务器未确认签到成功');
      } else if (
        typeof record?.gain === 'number' &&
        Number.isFinite(record.gain) &&
        record.gain > 0
      ) {
        state.gain = record.gain;
      }
      state.status = 'signed';
      state.checkedAt = deps.now();
      state.nextAttempt = 0;
      state.message = signed ? '服务器记录确认今日已签到' : '服务器已确认签到成功';
      await save();
      return { status: 'signed', state: { ...state } };
    } catch (error) {
      // A confirmed result is still known locally if its final storage write fails.
      // Other tabs retain the pre-request pending guard and must recheck the board.
      if (state.status !== 'signed') {
        state.status = 'failed';
        state.checkedAt = deps.now();
        state.nextAttempt = deps.now() + ATTENDANCE_COOLDOWN_MS;
        // Keep the custom implementation's useful failure feedback, bounded and local.
        state.message = (error instanceof Error ? error.message : '自动签到失败').slice(0, 160);
        await save();
      }
      return { status: 'failed', state: { ...state } };
    }
  }

  return {
    async scan(): Promise<AttendanceResult> {
      if (busy) return { status: 'busy' };
      busy = true;
      try {
        if (deps.now() < unavailableUntil) return { status: 'cooldown' };
        const account = deps.currentAccount();
        if (!account?.trim() || !deps.isVisible() || (await deps.readEnabled()) !== true) {
          return { status: 'skipped' };
        }
        return (await deps.withLock(ATTENDANCE_LOCK, () => run(account))) ?? { status: 'busy' };
      } catch {
        // Broken storage/settings/lock RPC must not trigger a scan-driven storm.
        unavailableUntil = deps.now() + ATTENDANCE_COOLDOWN_MS;
        return { status: 'failed' };
      } finally {
        busy = false;
      }
    },
  };
}
