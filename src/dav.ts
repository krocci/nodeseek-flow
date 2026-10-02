import { type Operation, mergeOps, validateOps, stable, uuid } from './core';
export type DavConfig = {
  url: string;
  username: string;
  password: string;
  enabled: boolean;
  progress: boolean;
  oneDriveRedirects?: boolean;
};
export const ONE_DRIVE_ORIGINS = [
  'https://*.microsoftpersonalcontent.com/*',
  'https://*.sharepoint.com/*',
  'https://*.1drv.com/*',
];
export function davBase(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw Error('WebDAV 地址须为不含凭据和查询参数的 HTTPS 目录');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}
const filePattern = /^flow-[a-zA-Z0-9-]{1,80}-[a-zA-Z0-9-]{1,80}\.json$/;
function decodeXML(x: string): string {
  return x.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m) => {
    const k = m.slice(1, -1);
    if (k[0] === '#') {
      const n = k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return (
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[k] || ''
    );
  });
}
export function davFiles(xml: string, base: URL): string[] {
  if (xml.length > 4_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('WebDAV 目录响应无效');
  if (!/<(?:[\w-]+:)?multistatus[\s>]/i.test(xml)) throw Error('服务器未返回 WebDAV 目录');
  const files = new Set<string>();
  for (const match of xml.matchAll(/<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w-]+:)?href\s*>/gi)) {
    const u = new URL(decodeXML(match[1].trim()), base);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname) || u.search || u.hash)
      continue;
    const name = u.pathname.slice(base.pathname.length);
    if (filePattern.test(name)) files.add(u.href);
  }
  if (files.size > 2000) throw Error('远端变更文件超过首版上限，请导出备份后维护');
  return [...files].sort();
}
export async function syncDav(
  config: DavConfig,
  local: Operation[],
  fetcher: typeof fetch = fetch,
): Promise<{ ops: Operation[]; files: number }> {
  const base = davBase(config.url);
  const auth =
    'Basic ' +
    btoa(String.fromCharCode(...new TextEncoder().encode(config.username + ':' + config.password)));
  const request = async (url: string, method: string, body?: string) => {
    const u = new URL(url);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname))
      throw Error('拒绝向同步目录外发送凭据');
    let r: Response;
    try {
      r = await fetcher(url, {
        method,
        headers: {
          Authorization: auth,
          ...(method === 'PROPFIND' ? { Depth: '1', 'Content-Type': 'application/xml' } : {}),
          ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        // Fetch removes Authorization when a redirect crosses origins. Only download
        // requests may follow; PROPFIND and PUT never redirect credentials or writes.
        redirect: method === 'GET' && config.oneDriveRedirects ? 'follow' : 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const timeout = ['TimeoutError', 'AbortError'].includes((e as Error).name);
      throw Error(
        'WebDAV ' +
          method +
          (timeout
            ? ' 请求超时，请稍后重试。'
            : ' 无法连接（Failed to fetch）。请检查 HTTPS 地址、主机授权和网络；AList / OneDrive 下载需开启下方的 OneDrive 跳转兼容并重新保存授权。'),
      );
    }
    if (r.url && new URL(r.url).protocol !== 'https:') throw Error('拒绝非 HTTPS 下载');
    if (!r.ok) {
      const help =
        r.status === 401
          ? '请检查用户名和应用密码。'
          : r.status === 403
            ? '账户无权限，或请求被网站验证拦截；写入请使用同步账户。'
            : r.status === 404
              ? '目录不存在；请填写已存在的 WebDAV 目录。'
              : '';
      throw Error('WebDAV ' + method + ' 失败（HTTP ' + r.status + '）' + help);
    }
    if (Number(r.headers.get('Content-Length')) > 6_000_000) throw Error('远端文件过大');
    return r;
  };
  const listing = await request(
    base.href,
    'PROPFIND',
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  );
  const files = davFiles(await listing.text(), base);
  let remote: Operation[] = [];
  let total = 0;
  for (const file of files) {
    const text = await (await request(file, 'GET')).text();
    total += text.length;
    if (text.length > 6_000_000 || total > 20_000_000) throw Error('同步下载超过容量预算');
    const data = JSON.parse(text);
    if (data.schema !== 'nodeseek-flow-ops' || data.version !== 1)
      throw Error('远端协议版本不受支持');
    remote = mergeOps(remote, validateOps(data.ops));
  }
  const allowed = local.filter((o) => o.collection !== 'progress' || config.progress);
  const merged = mergeOps(remote, allowed);
  const known = new Set(remote.map((o) => o.id));
  const pending = allowed.filter((o) => !known.has(o.id));
  // Immutable random-named files never overwrite another device. Read back before acknowledging.
  if (pending.length) {
    const name = 'flow-' + uuid() + '-' + uuid() + '.json';
    const body = JSON.stringify({ schema: 'nodeseek-flow-ops', version: 1, ops: pending });
    if (body.length > 6_000_000) throw Error('待上传数据过大');
    const url = new URL(name, base).href;
    await request(url, 'PUT', body);
    const saved = JSON.parse(await (await request(url, 'GET')).text());
    if (
      saved.schema !== 'nodeseek-flow-ops' ||
      saved.version !== 1 ||
      stable(validateOps(saved.ops)) !== stable(pending)
    )
      throw Error('远端回读不一致，本地变更仍保留');
  }
  return {
    ops: mergeOps(
      local,
      merged.filter((o) => o.collection !== 'progress' || config.progress),
    ),
    files: files.length + (pending.length ? 1 : 0),
  };
}
