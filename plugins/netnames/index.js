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
    let out = maskSegment(seg);
    const eq = seg.indexOf('=');
    if (eq > 0 && SECRET_WORD.test(seg.slice(0, eq))) out = `${seg.slice(0, eq)}=:secret`;
    else if (seg && prev && SECRET_WORD.test(prev)) out = ':secret';
    prev = seg;
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

  events.on('session:created', ({ userId, context }) => {
    const id = String(userId);
    if (!allow.has(id)) return;
    // Bound to this session's own buffer: a late callback after destroy (or after
    // the same user got a new session) can only touch its own, orphaned buffer.
    const buf = [];
    buffers.set(id, buf);
    const entries = new WeakMap();
    context.on('request', (request) => {
      try {
        const entry = shape(request);
        entries.set(request, entry);
        buf.push(entry);
        if (buf.length > max) buf.shift();
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
   *     tags: [Plugins]
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
   *     tags: [Plugins]
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
