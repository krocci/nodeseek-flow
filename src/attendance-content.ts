import { createAttendance, attendanceDay } from './attendance';
import { rpc, forumFetch } from './client';

export function installAttendance(allowed: () => boolean, currentAccount: () => string) {
  let token = '',
    scope = '',
    day = '',
    nextScan = 0,
    previousAccount = '';
  let signal: AbortSignal;
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw Error(name + '：' + (error instanceof Error ? error.message : '请求失败'));
    }
  };
  // Follow the custom implementation: use the rendered account and session API.
  // A fetched HTML shell need not contain the client-rendered user card.
  const guard = async () => {
    if (
      !token ||
      !(await rpc('attendanceCheck', { account: scope, token })) ||
      !allowed() ||
      document.hidden ||
      currentAccount() !== scope ||
      attendanceDay(Date.now()) !== day
    )
      throw Error('签到已关闭或账号已改变');
  };
  const json = async (url: string, init: RequestInit = {}) => {
    // Match the custom attendance request's explicit JSON content negotiation.
    const r = await forumFetch(
      url,
      signal,
      { cache: 'no-store', ...init, headers: { Accept: 'application/json', ...init.headers } },
      guard,
    );
    let data;
    try {
      data = await r.json();
    } catch {
      throw Error('网站返回了非 JSON 内容，请确认已登录并完成网站验证');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.success === false)
      throw Error('签到响应无效，请确认登录及网站验证状态');
    return data;
  };
  const readBoard = async () =>
    step('读取签到记录', async () => {
      const data = await json('/api/attendance/board?page=1');
      const candidates = [data, data.detail, data.data].filter((v) => v && typeof v === 'object');
      if (
        candidates.some(
          (v) =>
            v.success === false || v.error || (v.code !== undefined && ![0, 200].includes(v.code)),
        )
      )
        throw Error('签到接口返回错误');
      const owner = candidates.find(
        (v) =>
          Object.hasOwn(v, 'record') &&
          ((Array.isArray(v.list) && Number.isFinite(v.total)) || v.success === true),
      );
      if (!owner) throw Error('无法识别签到记录，停止自动提交');
      const record = owner.record;
      if (record === null) return null;
      if (!record || typeof record.created_at !== 'string' || String(record.member_id) !== scope)
        throw Error('签到记录无效或账号不一致');
      return { createdAt: record.created_at, gain: record.gain };
    });
  const engine = createAttendance({
    now: Date.now,
    readEnabled: async () =>
      allowed() && (!token || (await rpc('attendanceCheck', { account: scope, token }))),
    currentAccount: () => (/^[0-9]+$/.test(currentAccount()) ? currentAccount() : null),
    isVisible: () => !document.hidden,
    readState: (account) => rpc('attendanceRead', { account }),
    writeState: async (account, state) => {
      await rpc('attendanceWrite', { account, token, state });
    },
    withLock: async (_key, work) => {
      scope = currentAccount();
      const claim = await rpc('attendanceClaim', { account: scope });
      if (!claim?.token) return undefined;
      token = claim.token;
      day = attendanceDay(Date.now());
      signal = AbortSignal.timeout(60000);
      try {
        return await work();
      } finally {
        await rpc('attendanceRelease', { account: scope, token }).catch(() => {});
        token = '';
      }
    },
    getBoard: readBoard,
    post: async () =>
      step('提交签到', async () => {
        const csrf =
          document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
          document.cookie.match(/(?:^|; *)csrf_token=([^;]+)/)?.[1];
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (csrf) headers['X-CSRF-Token'] = csrf;
        // Already-signed responses may set success=false, so classify here rather
        // than using the board's stricter success validator.
        const r = await forumFetch(
          '/api/attendance?random=false',
          signal,
          { method: 'POST', headers, body: '{}' },
          guard,
        );
        const data = await r.json();
        await guard();
        const confirmed =
          data?.success === true ||
          /今天已完成签到|今日已签到|今天已签到/.test(String(data?.message || ''));
        if (!confirmed) throw Error(String(data?.message || '服务器未确认签到成功').slice(0, 120));
        // Confirm the server record belongs to the account being processed.
        // A success message alone cannot identify the signed account.
        const record = await readBoard();
        if (
          !record ||
          !Number.isFinite(Date.parse(record.createdAt)) ||
          attendanceDay(Date.parse(record.createdAt)) !== day
        )
          throw Error('服务器回复成功，但尚未确认当前账号今日记录；稍后自动复查，不立即重复提交');
        await guard();
        return { success: true };
      }),
  });
  return () => {
    if (!allowed() || document.hidden) return;
    const account = currentAccount();
    if (account === previousAccount && Date.now() < nextScan) return;
    previousAccount = account;
    nextScan = Date.now() + 60000;
    void engine.scan();
  };
}
