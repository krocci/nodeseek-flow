export type Row = {
  key: string;
  kind: string;
  scope: string;
  at: number;
  bytes: number;
  value: any;
};
let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  return (opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('nodeseek-flow', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('cache', { keyPath: 'key' });
      s.createIndex('at', 'at');
      s.createIndex('kind', 'kind');
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        opening = null;
      };
      resolve(r.result);
    };
    r.onerror = () => {
      opening = null;
      reject(r.error);
    };
  }));
}
export async function getRow(key: string): Promise<Row | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction('cache').objectStore('cache').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function setRow(
  key: string,
  kind: string,
  scope: string,
  value: unknown,
  expiresAt = Date.now() + 12000,
): Promise<void> {
  const db = await database();
  if (Date.now() >= expiresAt) throw Error('缓存写入已超时，请重试');
  const row = {
    key,
    kind,
    scope,
    value,
    at: Date.now(),
    bytes: new TextEncoder().encode(JSON.stringify(value)).length,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    const timer = setTimeout(
      () => {
        try {
          tx.abort();
        } catch {}
      },
      Math.max(1, expiresAt - Date.now()),
    );
    tx.objectStore('cache').put(row);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      clearTimeout(timer);
      reject(tx.error || Error('缓存写入已取消或超时'));
    };
  });
}
export async function rows(): Promise<Row[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction('cache').objectStore('cache').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function removeRows(keys: string[]): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    for (const k of keys) tx.objectStore('cache').delete(k);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || Error('缓存清理已取消'));
  });
}
export async function prune(maxMB: number, days: number): Promise<void> {
  const all = (await rows()).sort((a, b) => b.at - a.at);
  let size = 0;
  const expired: string[] = [];
  for (const r of all) {
    size += r.bytes;
    if (size > maxMB * 1024 * 1024 || r.at < Date.now() - days * 86400000) expired.push(r.key);
  }
  if (expired.length) await removeRows(expired);
}
