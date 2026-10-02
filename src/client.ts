export async function rpc<T = any>(type: string, payload: unknown = {}): Promise<T> {
  const bounded =
    ['cacheGet', 'cachePut', 'lease', 'release'].includes(type) || type.startsWith('attendance');
  const expiresAt = Date.now() + 12000;
  const request = chrome.runtime.sendMessage({ type, payload, ...(bounded ? { expiresAt } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await (
    bounded
      ? Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('扩展缓存或请求调度超时，请重试')), 15000);
          }),
        ])
      : request
  ).finally(() => {
    clearTimeout(timer);
  });
  if (!r?.ok) throw Error(r?.error || '扩展后台未响应，请刷新页面');
  return r.result;
}
export async function forumFetch(
  url: string,
  signal: AbortSignal,
  init: RequestInit = {},
  beforeRequest?: () => Promise<void>,
): Promise<Response> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let token = '';
  while (!token) {
    signal.throwIfAborted();
    const lease = await rpc('lease');
    if (lease.token) {
      token = lease.token;
      break;
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, lease.wait || 700);
      function cancel() {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  let status = 0,
    retryAt = 0;
  try {
    await beforeRequest?.();
    signal.throwIfAborted();
    const r = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      redirect: 'error',
      headers: { Accept: 'text/html,application/json', ...init.headers },
    });
    status = r.status;
    const retry = r.headers.get('Retry-After');
    retryAt =
      retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '');
    if (!r.ok)
      throw Error(
        '请求失败 HTTP ' +
          status +
          (status === 403 || status === 429 ? '，自动请求暂停 30 分钟' : ''),
      );
    return r;
  } finally {
    await rpc('release', { token, status, retryAt: Number.isFinite(retryAt) ? retryAt : 0 }).catch(
      () => {},
    );
  }
}
