/**
 * Host half of the ZenTao bug query plugin.
 *
 * Registers a same-origin HTTP route `/zentao-plugin/*` on the host
 * webServer and proxies the intranet ZenTao (禅道) web session API:
 *  - GET /zentao-plugin/bugs      → 我的地盘 → 指派给我 → Bug 列表
 *  - GET /zentao-plugin/bug/<id>  → bug 详情（含历史记录与评论）
 *
 * The browser half calls these paths same-origin, so no CORS and no
 * browser-held credentials are involved. The account password lives only
 * in this plugin's volatile Host config (plain text on this machine,
 * accepted by design).
 */
import Schema from '@deepseek-ai/schemastery';

export const Config = Schema.object({
  baseUrl: Schema.string()
    .description('禅道内网地址（含 /zentao 路径）')
    .default('')
    .volatile(),
  username: Schema.string().description('用户名').default('').volatile(),
  password: Schema.string().description('密码').default('').volatile(),
  showLeftSidebar: Schema.boolean().description('在左侧边栏展示入口').default(true).volatile(),
  showRightSidebar: Schema.boolean().description('在右侧边栏展示入口').default(true).volatile(),
});

export function apply(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/zentao-plugin',
      handler: (req, res) => handle(req, res).catch((err) => {
        sendJson(res, 502, { error: String((err && err.message) || err) });
      }),
    }), 'zentao-bugs: proxy route');
  });

  /** ----------------------------------------------------------------
   * ZenTao web session client (zentaosid-based, no cookie jar needed —
   * the session id travels in the URL query, matching ZenTao's own
   * API conventions; a Cookie header is sent as well for safety).
   */
  let sid = null;
  /** The credential triple this sid was logged in with. A mismatch forces
   *  re-login, so switching or clearing accounts can never reuse an old
   *  user's session. */
  let sidCreds = null;

  /** Read a config value; Schemastery `.volatile()` fields are live accessors with `.get()`. */
  function cfg(key) {
    const v = config ? config[key] : undefined;
    if (v && typeof v === 'object' && typeof v.get === 'function') return v.get();
    return v;
  }

  function credsKey() {
    return [cfg('baseUrl'), cfg('username'), cfg('password')].map((v) => String(v ?? '')).join('\u0000');
  }

  function sessionValid() {
    return !!sid && sidCreds === credsKey();
  }

  function base() {
    const url = String(cfg('baseUrl') || '').replace(/\/+$/, '');
    if (!url) throw new Error('请先在「设置 → 禅道」中配置禅道地址');
    return url;
  }

  async function raw(pathname, { post } = {}) {
    const url = base() + pathname + (pathname.includes('?') ? '&' : '?') + 'zentaosid=' + sid;
    const res = await fetch(url, {
      method: post ? 'POST' : 'GET',
      headers: {
        Cookie: 'zentaosid=' + sid,
        'X-Requested-With': 'XMLHttpRequest',
        ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('禅道 HTTP ' + res.status + '（' + pathname + '）');
    return res.json();
  }

  async function login() {
    const url = base() + '/api-getsessionid.json';
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const env = await res.json();
    const info = typeof env.data === 'string' ? JSON.parse(env.data) : env.data;
    if (!info || !info.sessionID) throw new Error('无法获取禅道会话 ID');
    sid = info.sessionID;
    const body = new URLSearchParams({
      account: String(cfg('username') || ''),
      password: String(cfg('password') || ''),
    });
    const lr = await fetch(base() + '/user-login.json?zentaosid=' + sid, {
      method: 'POST',
      headers: {
        Cookie: 'zentaosid=' + sid,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    const lenv = await lr.json();
    if (lenv.status !== 'success' || String(lenv.locate || '').includes('user-login')) {
      sid = null;
      sidCreds = null;
      throw new Error('禅道登录失败，请检查设置中的用户名和密码');
    }
    sidCreds = credsKey();
  }

  /** GET a ZenTao JSON page; re-login when the session is missing, bound to
   *  different credentials, or has expired. */
  async function zenGet(pathname) {
    if (!sessionValid()) await login();
    let env = await raw(pathname);
    let data = typeof env.data === 'string' ? JSON.parse(env.data) : env.data;
    const loggedOut = env.status !== 'success'
      || !data || /^(用户登录|访问受限)/.test(String(data.title || ''));
    if (loggedOut) {
      sid = null;
      await login();
      env = await raw(pathname);
      data = typeof env.data === 'string' ? JSON.parse(env.data) : env.data;
    }
    if (!data) throw new Error('禅道返回了空数据（' + pathname + '）');
    return data;
  }

  /** Rewrite ZenTao file links through the Host proxy (browser has no ZenTao session). */
  function absolutize(html) {
    if (typeof html !== 'string') return html || '';
    return html
      // /zentao/file-xxx.png | http(s)://host/zentao/file-xxx.png → /zentao-plugin/file/file-xxx.png
      .replace(/(src|href)="(?:https?:\/\/[^"]+)?\/zentao\/(file-[^"?#]+)([^"]*)"/g,
        '$1="/zentao-plugin/file/$2"')
      // Drop inline size handlers (setImageSize is a page global, undefined here).
      .replace(/\son(load|error|click)="[^"]*"/gi, '')
      .replace(/\son(load|error|click)='[^']*'/gi, '');
  }

  /** Fetch one ZenTao file with the session and stream it back. */
  const fileCache = new Map();
  async function fileBytes(name) {
    const hit = fileCache.get(name);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
    if (!sessionValid()) await login();
    const url = base() + '/' + name + '?zentaosid=' + sid;
    let res = await fetch(url, {
      headers: { Cookie: 'zentaosid=' + sid },
      signal: AbortSignal.timeout(30000),
    });
    // A redirect to the login page means the session expired: re-login and retry once.
    if (res.status >= 300 && res.status < 400) {
      sid = null;
      await login();
      res = await fetch(base() + '/' + name + '?zentaosid=' + sid, {
        headers: { Cookie: 'zentaosid=' + sid },
        signal: AbortSignal.timeout(30000),
      });
    }
    if (!res.ok) throw new Error('取图失败 HTTP ' + res.status);
    const type = String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    const entry = { at: Date.now(), type, buf };
    if (fileCache.size > 120) fileCache.clear();
    fileCache.set(name, entry);
    return entry;
  }

  let productsCache = { at: 0, map: {} };
  async function productNames() {
    if (Date.now() - productsCache.at < 10 * 60 * 1000 && productsCache.map) return productsCache.map;
    try {
      const data = await zenGet('/product-all.json');
      const map = {};
      const raw = data.products || {};
      if (raw && typeof raw === 'object') {
        for (const [id, name] of Object.entries(raw)) map[String(id)] = String(name);
      }
      productsCache = { at: Date.now(), map };
      return map;
    } catch {
      return productsCache.map || {};
    }
  }

  let bugsCache = { at: 0, payload: null };

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://x');
    // 配置不完整一律拒绝查询（清空配置后即使旧会话未过期也不可再用）。
    if (!cfg('baseUrl') || !cfg('username') || !cfg('password')) {
      return sendJson(res, 400, { error: '请先在「设置 → 禅道」中完整配置禅道地址、用户名和密码' });
    }
    if (pathname === '/zentao-plugin/bugs') {
      const force = new URL(req.url, 'http://x').searchParams.get('refresh') === '1';
      const ck = credsKey();
      if (!force && bugsCache.payload && bugsCache.ck === ck && Date.now() - bugsCache.at < 30000) {
        return sendJson(res, 200, bugsCache.payload);
      }
      const first = await zenGet('/my-work-bug-assignedTo--id_desc-0-500-1.json');
      // 禅道该接口的 recPerPage/page 参数只在 PATH_INFO 形式下生效
      // （my-work-bug-assignedTo--id_desc-<total>-<per>-<page>）。一次取全量；
      // 若单页容量不够（接口未来收紧上限）再按 pager 翻完剩余页。
      const pager = first.pager || {};
      const recTotal = Number(pager.recTotal) || 0;
      const perPage = Number(pager.recPerPage) || 500;
      const pageTotal = Math.min(Number(pager.pageTotal) || 1, 50);
      const rawAll = { ...(first.bugs && typeof first.bugs === 'object' ? first.bugs : {}) };
      for (let page = 2; page <= pageTotal; page++) {
        const data = await zenGet(`/my-work-bug-assignedTo--id_desc-${recTotal}-${perPage}-${page}.json`);
        const rb = data.bugs && typeof data.bugs === 'object' ? data.bugs : {};
        Object.assign(rawAll, rb);
      }
      const products = await productNames();
      const rawBugs = rawAll;
      const bugs = Object.values(rawBugs).map((b) => ({
        id: String(b.id),
        title: String(b.title || ''),
        product: String(b.product || ''),
        productName: products[String(b.product)] || ('产品 ' + b.product),
        severity: Number(b.severity) || 0,
        pri: Number(b.pri) || 0,
        status: String(b.status || ''),
        openedBy: String(b.openedBy || ''),
        openedDate: String(b.openedDate || ''),
      })).sort((a, b) => Number(b.id) - Number(a.id));
      const payload = { bugs, total: bugs.length, webBase: base() };
      bugsCache = { at: Date.now(), payload, ck };
      return sendJson(res, 200, payload);
    }
    // ZenTao attachment/step image: proxied so the browser needs no ZenTao session.
    const f = /^\/zentao-plugin\/file\/(file-[A-Za-z0-9_.\-]+)$/.exec(pathname);
    if (f) {
      const file = await fileBytes(f[1]);
      res.writeHead(200, {
        'Content-Type': file.type,
        'Content-Length': file.buf.length,
        'Cache-Control': 'private, max-age=300',
      });
      return res.end(file.buf);
    }
    const m = /^\/zentao-plugin\/bug\/(\d+)$/.exec(pathname);
    if (m) {
      const data = await zenGet('/bug-view-' + m[1] + '.json');
      const b = data.bug || {};
      const actionsSrc = data.actions && typeof data.actions === 'object' ? data.actions : {};
      const actions = Object.values(actionsSrc).map((a) => ({
        id: String(a.id || ''),
        action: String(a.action || ''),
        actor: String(a.actor || ''),
        date: String(a.date || ''),
        comment: absolutize(a.comment),
        history: Array.isArray(a.history) ? a.history.map((h) => ({
          field: String(h.field || ''),
          old: String(h.old ?? ''),
          new: String(h.new ?? ''),
        })) : [],
      }));
      const bug = {
        id: String(b.id),
        title: String(b.title || ''),
        product: String(b.product || ''),
        productName: (await productNames())[String(b.product)] || ('产品 ' + b.product),
        severity: Number(b.severity) || 0,
        pri: Number(b.pri) || 0,
        status: String(b.status || ''),
        type: String(b.type || ''),
        os: String(b.os || ''),
        browser: String(b.browser || ''),
        module: (() => {
          const p = Array.isArray(data.modulePath) ? data.modulePath[data.modulePath.length - 1] : '';
          const v = p && typeof p === 'object' ? (p.name || p.title || '') : (p || b.module || '');
          return String(v);
        })(),
        openedBy: String(b.openedBy || ''),
        openedDate: String(b.openedDate || ''),
        assignedTo: String((b.assignedTo && b.assignedTo.realname) || (typeof b.assignedTo === 'object' ? '' : b.assignedTo) || ''),
        assignedDate: String(b.assignedDate || ''),
        resolvedBy: String((b.resolvedBy && b.resolvedBy.realname) || (typeof b.resolvedBy === 'object' ? '' : b.resolvedBy) || ''),
        resolvedDate: String(b.resolvedDate || ''),
        resolution: String(b.resolution || ''),
        deadline: String(b.deadline || ''),
        steps: absolutize(b.steps),
        webUrl: base() + '/bug-view-' + m[1] + '.html',
      };
      return sendJson(res, 200, { bug, actions });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function sendJson(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }
}
