import { type Operation, mergeOps, validateOps, stable, uuid } from './core';
export type DavConfig = {
  url: string;
  username: string;
  password: string;
  enabled: boolean;
  progress: boolean;
  oneDriveRedirects?: boolean;
};
export type DavPacket = {
  schema: 'nodeseek-flow-ops';
  version: 1;
  ops: Operation[];
  snapshot?: true;
};
export type DavCache = { version: 1; files: Record<string, DavPacket> };
export type DavStats = { downloaded: number; reused: number; uploaded: number; bytes: number };
export const emptyDavCache = (): DavCache => ({ version: 1, files: {} });
export async function packetHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function packet(text: string): DavPacket {
  const data = JSON.parse(text);
  if (data.schema !== 'nodeseek-flow-ops' || data.version !== 1)
    throw Error('远端协议版本不受支持');
  return {
    schema: data.schema,
    version: data.version,
    ops: validateOps(data.ops),
    ...(data.snapshot === true ? { snapshot: true as const } : {}),
  };
}
const contentHash = (url: string) =>
  new URL(url).pathname.match(/\/flow-sha256-([a-f0-9]{64})\.json$/)?.[1];
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
function davTransport(config: DavConfig, fetcher: typeof fetch) {
  const base = davBase(config.url);
  const auth =
    'Basic ' +
    btoa(String.fromCharCode(...new TextEncoder().encode(config.username + ':' + config.password)));
  const request = async (
    url: string,
    method: string,
    body?: string,
    extra: Record<string, string> = {},
  ) => {
    const u = new URL(url);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname))
      throw Error('拒绝向同步目录外发送凭据');
    let r: Response;
    try {
      r = await fetcher(url, {
        method,
        headers: {
          Authorization: auth,
          ...extra,
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
  return { base, request };
}
async function readRemote(config: DavConfig, fetcher: typeof fetch, cache: DavCache) {
  const { base, request } = davTransport(config, fetcher);
  const listing = await request(
    base.href,
    'PROPFIND',
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>',
  );
  const files = davFiles(await listing.text(), base);
  let remote: Operation[] = [];
  const hashes = new Map<string, string>();
  const stats: DavStats = { downloaded: 0, reused: 0, uploaded: 0, bytes: 0 };
  const nextCache = emptyDavCache();
  for (const file of files) {
    const digest = contentHash(file);
    // The namespace is an immutable content-addressed protocol, not an ETag
    // promise: OpenList accepts writes/deletes even with an incorrect If-Match.
    let data = digest && cache.version === 1 ? cache.files[file] : undefined;
    if (data && (await packetHash(stable(data))) !== digest) data = undefined;
    if (data) stats.reused++;
    else {
      const text = await (await request(file, 'GET')).text();
      const bytes = new TextEncoder().encode(text).length;
      stats.bytes += bytes;
      stats.downloaded++;
      if (bytes > 6_000_000 || stats.bytes > 20_000_000) throw Error('同步下载超过容量预算');
      data = packet(text);
      const hash = await packetHash(digest ? stable(data) : text);
      if (digest && hash !== digest) throw Error('远端文件内容与 SHA-256 文件名不一致，已停止同步');
      hashes.set(file, hash);
    }
    if (digest) {
      nextCache.files[file] = data;
      hashes.set(file, digest);
    }
    remote = mergeOps(remote, data.ops);
  }
  // Only publish a complete validated listing. Partial reads do not poison cache.
  cache.version = 1;
  cache.files = nextCache.files;
  return { base, request, files, hashes, remote, stats };
}
export async function syncDav(
  config: DavConfig,
  local: Operation[],
  fetcher: typeof fetch = fetch,
  cache: DavCache = emptyDavCache(),
): Promise<{ ops: Operation[]; files: number; stats: DavStats }> {
  let read: Awaited<ReturnType<typeof readRemote>>;
  try {
    read = await readRemote(config, fetcher, cache);
  } catch (e) {
    // Another device may have just moved old logs into its verified archive.
    if (!/GET.*HTTP 404/.test((e as Error).message)) throw e;
    read = await readRemote(config, fetcher, cache);
  }
  const { base, request, files, remote, stats } = read;
  const allowed = local.filter((o) => o.collection !== 'progress' || config.progress);
  const merged = mergeOps(remote, allowed);
  const known = new Set(remote.map((o) => o.id));
  const pending = allowed.filter((o) => !known.has(o.id));
  // Same contents yield the same immutable name. Existing v1 clients can still
  // read the packet and preserve all causal contexts and deletion operations.
  if (pending.length) {
    const data: DavPacket = { schema: 'nodeseek-flow-ops', version: 1, ops: pending };
    const body = stable(data);
    const name = 'flow-sha256-' + (await packetHash(body)) + '.json';
    if (new TextEncoder().encode(body).length > 6_000_000) throw Error('待上传数据过大');
    const url = new URL(name, base).href;
    await request(url, 'PUT', body);
    const saved = packet(await (await request(url, 'GET')).text());
    if (
      saved.schema !== 'nodeseek-flow-ops' ||
      saved.version !== 1 ||
      stable(validateOps(saved.ops)) !== stable(pending)
    )
      throw Error('远端回读不一致，本地变更仍保留');
    cache.files[url] = data;
    stats.uploaded++;
  }
  return {
    ops: mergeOps(
      local,
      merged.filter((o) => o.collection !== 'progress' || config.progress),
    ),
    files: files.length + (pending.length ? 1 : 0),
    stats,
  };
}

// File compaction only: keep every operation/context/tombstone, including data
// from offline devices. No history truncation or last-writer-wins conversion.
export async function compactDav(
  config: DavConfig,
  fetcher: typeof fetch = fetch,
  cache: DavCache = emptyDavCache(),
) {
  const { base, request, files, hashes, remote } = await readRemote(config, fetcher, cache);
  if (files.length < 2)
    return { archived: 0, remaining: files.length, archive: '', snapshot: files[0] || '' };
  const data: DavPacket = { schema: 'nodeseek-flow-ops', version: 1, ops: remote, snapshot: true };
  const body = stable(data);
  if (new TextEncoder().encode(body).length > 6_000_000)
    throw Error('快照超过容量上限，保留原文件');
  const url = new URL('flow-sha256-' + (await packetHash(body)) + '.json', base).href;
  await request(url, 'PUT', body);
  const verified = packet(await (await request(url, 'GET')).text());
  if (stable(verified) !== body) throw Error('快照回读不一致，未归档历史文件');
  cache.files[url] = data;
  const archive = new URL('flow-archive-' + uuid() + '/', base).href;
  await request(archive, 'MKCOL');
  let archived = 0;
  for (const file of files) {
    if (file === url) continue;
    // Recheck before moving. Only originally observed immutable files qualify;
    // concurrent new uploads are never included in this archive operation.
    let text: string;
    try {
      text = await (await request(file, 'GET')).text();
    } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) continue;
      throw e;
    }
    if ((await packetHash(contentHash(file) ? stable(packet(text)) : text)) !== hashes.get(file))
      continue;
    await request(file, 'MOVE', undefined, {
      Destination: new URL(new URL(file).pathname.split('/').at(-1)!, archive).href,
      Overwrite: 'F',
    });
    delete cache.files[file];
    archived++;
  }
  const listing = await request(
    base.href,
    'PROPFIND',
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  );
  return {
    archived,
    remaining: davFiles(await listing.text(), base).length,
    archive,
    snapshot: url,
  };
}
