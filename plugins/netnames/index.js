/**
 * Request-shape recorder: method, host, masked path, query key names, status
 * and top-level JSON body key names, held in a bounded in-memory ring buffer.
 * Never headers, cookies, tokens, body values or query values; never on disk.
 *
 * Off unless configured, in camofox.config.json:
 *   "plugins": { "netnames": { "enabled": true, "userIds": ["agent1"], "maxEntries": 2000, "workerHook": false } }
 */
const MAX_DEFAULT = 2000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Order matters: thread ids and GUIDs before the generic runs they contain.
const MASKS = [
  [/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/, ':jwt'],
  [/^\d+:[^/]*@thread[\w.]*$/i, ':thread'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':guid'],
  [/^[0-9a-f]{16,}$/i, ':hex'],
  [/^[A-Za-z0-9_-]{24,}={0,2}$/, ':b64'],
  [/^\d{7,}$/, ':num'],
];

export function maskSegment(seg) {
  let s = seg;
  try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
  for (const [re, label] of MASKS) if (re.test(s)) return label;
  return seg;
}

// A segment that follows a secret-bearing word, or is itself key=value with one,
// is a credential whatever it looks like (e.g. /reset/<opaque-token>).
const SECRET_WORD = /(token|secret|password|passwd|signature|sig|apikey|api_key|key|code|reset|verify|invite|confirm|activate)$/i;

export function maskPath(pathname) {
  let prev = '';
  return pathname.split('/').map((seg) => {
    // Decode once so a percent-encoded token or key=value cannot dodge the checks.
    let dec = seg;
    try { dec = decodeURIComponent(seg); } catch { /* keep raw */ }
    let out = maskSegment(seg);
    const eq = dec.indexOf('=');
    if (eq > 0 && SECRET_WORD.test(dec.slice(0, eq))) out = `${dec.slice(0, eq)}=:secret`;
    else if (dec && prev && SECRET_WORD.test(prev)) out = ':secret';
    // A key=value or already-masked segment is complete: it must not mask its successor (idempotence).
    prev = eq > 0 || out.startsWith(':') ? '' : dec;
    return out;
  }).join('/');
}

export function bodyKeys(method, postData) {
  if (!BODY_METHODS.has(method) || !postData) return undefined;
  try {
    const v = JSON.parse(postData);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v);
  } catch { /* not JSON */ }
  return undefined;
}

export function bodyShape(text, depth = 5, withBooleans = false) {
  const keyName = (k) => (/[0-9]/.test(k) ? maskSegment(k) : k).slice(0, 100);
  const walk = (v, d) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'string' && d > 1 && /^\s*\{/.test(v)) { // a JSON object carried as a string
      try { const inner = JSON.parse(v); if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { '(json string)': walk(inner, d - 1) }; } catch { /* plain string */ }
    }
    if (withBooleans && typeof v === 'boolean') return String(v);
    if (withBooleans && Number.isInteger(v) && Math.abs(v) < 1000) return String(v); // small setting enums only
    if (typeof v !== 'object') return typeof v;
    if (d <= 0) return 'object';
    const out = {};
    for (const k of Object.keys(v).slice(0, 50)) out[keyName(k)] = walk(v[k], d - 1);
    return out;
  };
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? walk(v, depth) : undefined;
  } catch { return undefined; }
}

export function shape(request, booleans = false) {
  const url = new URL(request.url());
  const method = request.method();
  const entry = {
    t: Date.now(),
    method,
    host: url.host,
    path: maskPath(url.pathname),
    query: [...new Set(url.searchParams.keys())],
    status: null,
    fromWorker: !!request.serviceWorker?.(),
  };
  const keys = bodyKeys(method, request.postData?.());
  if (keys) { entry.bodyKeys = keys; entry.bodyShape = bodyShape(request.postData(), 5, booleans); }
  return entry;
}


// ---- opt-in JS-layer hook: dedicated/shared/blob/module worker requests -------------
// Playwright's Firefox backend does not report worker fetches, so an init script wraps the
// Worker and SharedWorker constructors; each worker first installs names-only wrappers on
// fetch, XMLHttpRequest and WebSocket.send, then loads the original script. Records travel
// over a same-origin BroadcastChannel to the page, which forwards them to an exposed binding.
// shortcut: service workers are not wrapped (no constructor to hook), and a wrapped worker's
// self.location is a blob: URL; relative fetch/importScripts URLs are resolved against the
// original script URL, other uses of self.location see the blob. Upgrade if a client needs it.
const BODY_KEYS_SRC = `const BODY_METHODS=new Set(['POST','PUT','PATCH']);` + bodyKeys.toString();
const HELPERS_SRC = [
  `const MASKS=[${MASKS.map(([re, label]) => `[${re},${JSON.stringify(label)}]`).join(',')}];`,
  `const SECRET_WORD=${SECRET_WORD};`,
  BODY_KEYS_SRC, maskSegment.toString(), bodyShape.toString(), maskPath.toString(),
].join('\n');

// Runs inside pages and workers; must be self-contained apart from the helpers above.
function core(ctx) {
  const g = globalThis;
  const report = ctx.report || ((bc) => (r) => bc.postMessage(r))(new BroadcastChannel('__nn'));
  const abs = (u) => { try { return new URL(String(u), ctx.original || g.document?.baseURI || g.location.href); } catch { return null; } };
  const rec = (method, url, body, extra, hdrs) => {
    try {
      const u = abs(url);
      if (!u) return;
      const m = String(method || 'GET').toUpperCase();
      const r = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), t: Date.now(), method: m, host: u.host, path: maskPath(u.pathname),
        query: [...new Set(u.searchParams.keys())], status: null, via: ctx.worker ? 'worker' : 'page-ws' };
      const keys = typeof body === 'string' ? bodyKeys(extra || m, body) : undefined;
      if (keys) { r.bodyKeys = keys; r.bodyShape = bodyShape(body, 5, ctx.booleans); }
      if (hdrs) r.headerNames = [...new Set(hdrs)].slice(0, 50);
      report(r);
    } catch { /* never break the page */ }
  };
  const resolveInput = (input) => (typeof input === 'string' || input instanceof URL) && ctx.original ? String(abs(input) || input) : input;

  if (ctx.worker) {
    const of = g.fetch;
    if (of) g.fetch = function (input, init) {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      let hn;
      try { hn = [...new Headers(init?.headers || (isReq ? input.headers : undefined)).keys()]; } catch { /* no headers */ }
      rec(init?.method || (isReq ? input.method : 'GET'), isReq ? input.url : input, init?.body, undefined, hn);
      return of.call(this, resolveInput(input), init);
    };
    if (g.XMLHttpRequest) {
      const oo = g.XMLHttpRequest.prototype.open, os = g.XMLHttpRequest.prototype.send;
      const osh = g.XMLHttpRequest.prototype.setRequestHeader;
      g.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try { (this.__nnh ||= []).push(String(name).toLowerCase()); } catch { /* ignore */ }
        return osh.call(this, name, value);
      };
      g.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__nn = [method, url]; this.__nnh = [];
        return oo.call(this, method, resolveInput(url), ...rest);
      };
      g.XMLHttpRequest.prototype.send = function (body) {
        if (this.__nn) rec(this.__nn[0], this.__nn[1], body, undefined, this.__nnh);
        return os.call(this, body);
      };
    }
    if (g.importScripts && ctx.original) {
      const oi = g.importScripts;
      g.importScripts = (...urls) => oi.apply(g, urls.map((u) => String(abs(u) || u)));
    }
  }
  if (g.WebSocket) {
    const wsend = g.WebSocket.prototype.send;
    g.WebSocket.prototype.send = function (data) {
      rec('WS-SEND', this.url, data, 'POST');
      return wsend.call(this, data);
    };
  }
  // Wrap worker constructors, including from inside a worker (nested workers).
  for (const name of ctx.noWrap ? [] : ['Worker', 'SharedWorker']) {
    const Orig = g[name];
    if (!Orig) continue;
    const blobs = new Map();
    const Wrapped = function (url, opts) {
      if (!new.target) return Orig(url, opts);
      let boot;
      try {
        const u = abs(url);
        const type = opts && opts.type === 'module' ? 'module' : 'classic';
        const key = `${type}|${u.href}`;
        boot = blobs.get(key);
        if (!boot) {
          const setup = `${ctx.lib}\n__core({worker:true,booleans:${!!ctx.booleans},original:${JSON.stringify(u.href)},lib:${JSON.stringify(ctx.lib)}});\n`;
          const mk = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
          // Module: static imports run in order and need no top-level await (which dropped early messages).
          boot = type === 'module'
            ? mk(`import ${JSON.stringify(mk(setup))};\nimport ${JSON.stringify(u.href)};`)
            : mk(`(() => {\n${setup}})();\nimportScripts(${JSON.stringify(u.href)});`);
          blobs.set(key, boot);
        }
      } catch { return Reflect.construct(Orig, [url, opts], new.target); }
      return Reflect.construct(Orig, [boot, opts], new.target); // new.target keeps subclass prototypes
    };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    g[name] = Wrapped;
  }
}

// Route mode: prepend the wrappers to each worker script response, so the worker keeps its own
// URL and self.location (the blob bootstrap above changes both). Nested workers load through the
// same route, so no constructor is wrapped.
export function workerPrelude(booleans = false) {
  const lib = `${HELPERS_SRC}\nconst __core=${core.toString()};`;
  return `;(() => {${lib}\n__core({worker:true,noWrap:true,booleans:${booleans}});})();\n`;
}

// Keep a leading 'use strict' directive first, or the prelude would silently turn strict mode off.
export function withPrelude(prelude, text) {
  const m = /^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(['"])use strict\2;?)/.exec(text);
  return m ? m[1] + '\n' + prelude + text.slice(m[1].length) : prelude + text;
}

const WORKER_DESTS = new Set(['worker', 'sharedworker', 'serviceworker']);

export function hookScript(noWrap = false, booleans = false) {
  const lib = `${HELPERS_SRC}\nconst __core=${core.toString()};`;
  return `(() => {
  if (globalThis.__nnHooked) return; globalThis.__nnHooked = true;
  ${lib}
  const bc = new BroadcastChannel('__nn');
  bc.onmessage = (e) => { try { window.__nnReport(e.data); } catch {} };
  __core({ worker: false, noWrap: ${noWrap}, booleans: ${booleans}, lib: ${JSON.stringify(lib)}, report: (r) => { try { window.__nnReport(r); } catch {} } });
})();`;
}

// The binding is page-controlled, so keep only fields of the right type and re-mask the path.
export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const names = (a) => (Array.isArray(a) ? a.filter((k) => typeof k === 'string').slice(0, 100).map((k) => k.slice(0, 100)) : []);
  const out = { t: Date.now(), method: str(r.method, 10).toUpperCase(), host: str(r.host, 255),
    path: maskPath(str(r.path, 2000)), query: names(r.query), status: null, fromWorker: true, via: r.via === 'page-ws' ? 'page-ws' : 'worker' };
  if (Array.isArray(r.bodyKeys)) out.bodyKeys = names(r.bodyKeys);
  const TYPES = new Set(['true', 'false', 'string', 'number', 'boolean', 'object', 'array', 'null', 'undefined']);
  const clean = (v, d) => {
    if (typeof v === 'string') return TYPES.has(v) || /^-?\d{1,3}$/.test(v) ? v : 'string';
    if (!v || typeof v !== 'object' || d <= 0) return 'object';
    return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [maskSegment(k.slice(0, 100)), clean(x, d - 1)]));
  };
  if (Array.isArray(r.headerNames)) out.headerNames = r.headerNames.filter((k) => typeof k === 'string').slice(0, 50).map((k) => k.toLowerCase().slice(0, 60));
  if (r.bodyShape && typeof r.bodyShape === 'object') out.bodyShape = clean(r.bodyShape, 5);
  return out.method && out.host ? out : null;
}

export function register(app, ctx, pluginConfig = {}) {
  const { events, auth, log } = ctx;
  const allow = new Set((pluginConfig.userIds || []).map(String));
  if (pluginConfig.enabled !== true || allow.size === 0) {
    log('info', 'netnames plugin: disabled (needs enabled:true and userIds)');
    return;
  }
  const max = Number(pluginConfig.maxEntries) > 0 ? Math.floor(Number(pluginConfig.maxEntries)) : MAX_DEFAULT;
  const buffers = new Map();

  events.on('session:created', async ({ userId, context }) => {
    const id = String(userId);
    if (!allow.has(id)) return;
    // Bound to this session's own buffer: a late callback after destroy (or after
    // the same user got a new session) can only touch its own, orphaned buffer.
    const buf = [];
    buffers.set(id, buf);
    const push = (entry) => { buf.push(entry); if (buf.length > max) buf.shift(); };
    if (pluginConfig.workerHook === true) {
      try {
        // Every same-origin page hears the BroadcastChannel, so one record can arrive more than once.
        const seen = new Set();
        await context.exposeBinding('__nnReport', (_src, r) => {
          const e = sanitizeRecord(r);
          if (!e || (r.id && seen.has(r.id))) return;
          if (r.id) { seen.add(String(r.id).slice(0, 40)); if (seen.size > 2000) seen.delete(seen.values().next().value); }
          push(e);
        });
        if (pluginConfig.workerHookMode === 'route') {
          const prelude = workerPrelude(pluginConfig.bodyBooleans === true);
          await context.route(() => true, async (route) => {
            try {
              const dest = route.request().headers()['sec-fetch-dest'];
              if (!WORKER_DESTS.has(dest)) return await route.continue();
              const resp = await route.fetch();
              const type = resp.headers()['content-type'] || '';
              if (resp.status() !== 200 || !/javascript|ecmascript|text\/plain|^$/i.test(type)) return await route.fulfill({ response: resp });
              await route.fulfill({ response: resp, body: withPrelude(prelude, await resp.text()) });
            } catch { try { await route.continue(); } catch { /* handled */ } }
          });
        }
        await context.addInitScript(hookScript(pluginConfig.workerHookMode === 'route', pluginConfig.bodyBooleans === true));
      } catch (err) { log('warn', 'netnames worker hook failed', { error: String(err && err.message || err) }); }
    }
    const entries = new WeakMap();
    context.on('request', (request) => {
      try {
        const entry = shape(request, pluginConfig.bodyBooleans === true);
        entries.set(request, entry);
        push(entry);
      } catch { /* unparsable url */ }
    });
    context.on('requestfinished', async (request) => {
      const entry = entries.get(request);
      if (!entry) return;
      try { entry.status = (await request.response())?.status() ?? null; } catch { /* gone */ }
    });
    context.on('requestfailed', (request) => {
      const entry = entries.get(request);
      if (entry) entry.failed = true;
    });
  });

  events.on('session:destroyed', ({ userId }) => buffers.delete(String(userId)));

  /**
   * @openapi
   * /plugins/netnames/{userId}:
   *   get:
   *     tags: [System]
   *     summary: Read recorded request shapes
   *     description: Only registered when the netnames plugin is enabled. Holds request shapes (masked path, key names), never values.
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: userId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Buffer entries.
   *       404:
   *         description: User is not allow-listed or has no session.
   */
  app.get('/plugins/netnames/:userId', auth(), (req, res) => {
    const buf = buffers.get(String(req.params.userId));
    if (!buf) return res.status(404).json({ error: 'not recorded' });
    res.json({ count: buf.length, entries: buf });
  });
  /**
   * @openapi
   * /plugins/netnames/{userId}:
   *   delete:
   *     tags: [System]
   *     summary: Clear recorded request shapes
   *     description: Only registered when the netnames plugin is enabled. Holds request shapes (masked path, key names), never values.
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: userId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Cleared.
   *       404:
   *         description: User is not allow-listed or has no session.
   */
  app.delete('/plugins/netnames/:userId', auth(), (req, res) => {
    const buf = buffers.get(String(req.params.userId));
    if (!buf) return res.status(404).json({ error: 'not recorded' });
    buf.length = 0;
    res.json({ ok: true });
  });
  log('info', 'netnames plugin enabled', { users: allow.size, max });
}
