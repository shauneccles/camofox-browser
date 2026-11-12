/**
 * Request-shape recorder: method, host, masked path, query key names, status
 * and top-level JSON body key names, held in a bounded in-memory ring buffer.
 * Never headers, cookies, tokens, body values or query values; never on disk.
 *
 * Off unless configured, in camofox.config.json:
 *   "plugins": { "netnames": { "enabled": true, "userIds": ["agent1"], "maxEntries": 2000 } }
 */
const MAX_DEFAULT = 2000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Order matters: thread ids and GUIDs before the generic runs they contain.
const MASKS = [
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

export function maskPath(pathname) {
  return pathname.split('/').map(maskSegment).join('/');
}

export function bodyKeys(method, postData) {
  if (!BODY_METHODS.has(method) || !postData) return undefined;
  try {
    const v = JSON.parse(postData);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v);
  } catch { /* not JSON */ }
  return undefined;
}

export function shape(request) {
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
  if (keys) entry.bodyKeys = keys;
  return entry;
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

  const push = (userId, entry) => {
    const buf = buffers.get(userId);
    buf.push(entry);
    if (buf.length > max) buf.shift();
  };

  events.on('session:created', ({ userId, context }) => {
    const id = String(userId);
    if (!allow.has(id)) return;
    buffers.set(id, []);
    const pending = new WeakMap();
    context.on('request', (request) => {
      try { pending.set(request, shape(request)); } catch { /* unparsable url */ }
    });
    context.on('requestfinished', async (request) => {
      const entry = pending.get(request);
      if (!entry) return;
      try { entry.status = (await request.response())?.status() ?? null; } catch { /* gone */ }
      push(id, entry);
    });
    context.on('requestfailed', (request) => {
      const entry = pending.get(request);
      if (entry) push(id, entry);
    });
  });

  events.on('session:destroyed', ({ userId }) => buffers.delete(String(userId)));

  app.get('/plugins/netnames/:userId', auth(), (req, res) => {
    const buf = buffers.get(String(req.params.userId));
    if (!buf) return res.status(404).json({ error: 'not recorded' });
    res.json({ count: buf.length, entries: buf });
  });
  app.delete('/plugins/netnames/:userId', auth(), (req, res) => {
    const buf = buffers.get(String(req.params.userId));
    if (!buf) return res.status(404).json({ error: 'not recorded' });
    buf.length = 0;
    res.json({ ok: true });
  });
  log('info', 'netnames plugin enabled', { users: allow.size, max });
}
