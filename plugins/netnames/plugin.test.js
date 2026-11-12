import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createPluginEvents } from '../../lib/plugins.js';
import vm from 'node:vm';
import { register, maskPath, bodyKeys, sanitizeRecord, hookScript } from './index.js';

const GUID = '123e4567-e89b-12d3-a456-426614174000';

function fakeRequest(url, { method = 'GET', body, status = 200, sw = false, headers = { authorization: 'Bearer SECRET' } } = {}) {
  return {
    url: () => url, method: () => method, postData: () => body,
    headers: () => headers, serviceWorker: () => (sw ? {} : null),
    response: async () => ({ status: () => status }),
  };
}

function setup(cfg) {
  const events = createPluginEvents();
  const routes = {};
  const authMw = jest.fn((req, res, next) => next());
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h; },
    delete: (p, ...h) => { routes['DELETE ' + p] = h; },
  };
  const ctx = { events, auth: () => authMw, log: jest.fn() };
  register(app, ctx, cfg);
  return { events, routes, authMw, ctx };
}

async function session(events, userId) {
  const context = new EventEmitter();
  await events.emitAsync('session:created', { userId, context });
  return context;
}

async function fire(context, req) {
  context.emit('request', req);
  context.emit('requestfinished', req);
  await new Promise((r) => setImmediate(r));
}

const call = (routes, key, userId) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const [mw, handler] = routes[key];
  mw({}, res, () => {});
  handler({ params: { userId } }, res);
  return res;
};

describe('netnames', () => {
  test('off by default', () => {
    const { routes, ctx } = setup({});
    expect(routes).toEqual({});
    expect(ctx.log).toHaveBeenCalledWith('info', expect.stringContaining('disabled'));
    expect(setup({ enabled: true }).routes).toEqual({});
  });

  test('masks percent-encoded secrets', () => {
    expect(maskPath('/a/reset/abc%2Fdef%20ghi')).toBe('/a/reset/:secret');
    expect(maskPath('/a/api%5Fkey%3Dhunter2/b')).toBe('/a/api_key=:secret/b');
    expect(maskPath('/a/to%6Ben/hunter2')).toBe('/a/to%6Ben/:secret');
  });

  test('masks each id shape', () => {
    expect(maskPath(`/v1/threads/19:abc123@thread.v2/messages/${GUID}`)).toBe('/v1/threads/:thread/messages/:guid');
    expect(maskPath('/a/0123456789abcdef0123/b')).toBe('/a/:hex/b');
    expect(maskPath('/a/QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu/b')).toBe('/a/:b64/b');
    expect(maskPath('/a/12345678/b/123456')).toBe('/a/:num/b/123456');
    expect(maskPath('/verify/eyJhbGciOi.eyJzdWIiOiIx.sig_-x/b')).toBe('/verify/:secret/b');
    expect(maskPath('/a/eyJhbGciOi.eyJzdWIiOiIx.sig_-x')).toBe('/a/:jwt');
    expect(maskPath('/oauth/access_token/abc-def/x')).toBe('/oauth/access_token/:secret/x');
    expect(maskPath('/cb/access_token=abc.def')).toBe('/cb/access_token=:secret');
    expect(maskPath('/reset/opaque-word')).toBe('/reset/:secret');
    expect(maskPath('/a/19%3Aabc%40thread.v2/b')).toBe('/a/:thread/b');
  });

  test('body keys only, top level, write methods only', () => {
    expect(bodyKeys('POST', JSON.stringify({ a: 'secret', b: { c: 1 } }))).toEqual(['a', 'b']);
    expect(bodyKeys('GET', '{"a":1}')).toBeUndefined();
    expect(bodyKeys('PUT', 'not json')).toBeUndefined();
    expect(bodyKeys('PATCH', '[1]')).toBeUndefined();
  });

  test('records allow-listed users only, never headers or values', async () => {
    const { events, routes } = setup({ enabled: true, userIds: ['u1'] });
    const ctx1 = await session(events, 'u1');
    const ctx2 = await session(events, 'u2');
    await fire(ctx1, fakeRequest('https://x.example/api/' + GUID + '?token=SECRETVAL&a=1', { method: 'POST', body: '{"msg":"SECRETBODY"}', status: 201, sw: true }));
    await fire(ctx2, fakeRequest('https://x.example/other'));
    const res = call(routes, 'GET /plugins/netnames/:userId', 'u1');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ method: 'POST', host: 'x.example', path: '/api/:guid', query: ['token', 'a'], status: 201, fromWorker: true, bodyKeys: ['msg'] });
    const dump = JSON.stringify(res.body);
    for (const s of ['SECRET', 'authorization', 'Bearer']) expect(dump).not.toContain(s);
    expect(call(routes, 'GET /plugins/netnames/:userId', 'u2').statusCode).toBe(404);
  });

  test('buffer is bounded and can be cleared', async () => {
    const { events, routes } = setup({ enabled: true, userIds: ['u1'], maxEntries: 3 });
    const c = await session(events, 'u1');
    for (let i = 0; i < 5; i++) await fire(c, fakeRequest(`https://x.example/p${i}`));
    const res = call(routes, 'GET /plugins/netnames/:userId', 'u1');
    expect(res.body.entries.map((e) => e.path)).toEqual(['/p2', '/p3', '/p4']);
    call(routes, 'DELETE /plugins/netnames/:userId', 'u1');
    expect(call(routes, 'GET /plugins/netnames/:userId', 'u1').body.count).toBe(0);
  });

  test('records at request time, so in-flight and failed requests show', async () => {
    const { events, routes } = setup({ enabled: true, userIds: ['u1'] });
    const c = await session(events, 'u1');
    const open = fakeRequest('https://x.example/stream');
    const bad = fakeRequest('https://x.example/bad');
    c.emit('request', open);
    c.emit('request', bad);
    c.emit('requestfailed', bad);
    const e = call(routes, 'GET /plugins/netnames/:userId', 'u1').body.entries;
    expect(e.map((x) => [x.path, x.status, !!x.failed])).toEqual([['/stream', null, false], ['/bad', null, true]]);
  });

  test('a completion after session destroy does not throw', async () => {
    const { events, routes } = setup({ enabled: true, userIds: ['u1'] });
    const c = await session(events, 'u1');
    const r = fakeRequest('https://x.example/a');
    c.emit('request', r);
    c.emit('requestfinished', r);
    await events.emitAsync('session:destroyed', { userId: 'u1' });
    await new Promise((x) => setImmediate(x));
    expect(call(routes, 'GET /plugins/netnames/:userId', 'u1').statusCode).toBe(404);
  });

  test('endpoints sit behind the auth middleware', () => {
    const { routes, authMw } = setup({ enabled: true, userIds: ['u1'] });
    expect(routes['GET /plugins/netnames/:userId'][0]).toBe(authMw);
    expect(routes['DELETE /plugins/netnames/:userId'][0]).toBe(authMw);
  });

  describe('worker hook', () => {
    test('sanitizeRecord keeps names only and re-masks the path', () => {
      const e = sanitizeRecord({ method: 'post', host: 'a.b', path: '/x/reset/abc123', query: ['q', 5], bodyKeys: ['k'], token: 'SECRET', headers: { a: 1 } });
      expect(e).toMatchObject({ method: 'POST', host: 'a.b', path: '/x/reset/:secret', query: ['q'], bodyKeys: ['k'], fromWorker: true });
      expect(JSON.stringify(e)).not.toMatch(/SECRET|abc123/);
      expect(sanitizeRecord(null)).toBeNull();
      expect(sanitizeRecord({ host: 'a' })).toBeNull();
    });

    test('hook wraps WebSocket.send and Worker, reporting names only', () => {
      const reports = [];
      const made = [];
      class WebSocket { constructor() { this.url = `ws://h.test/s/${GUID}?k=v`; } send() {} }
      class Worker { constructor(u, o) { made.push([u, o]); } }
      const sandbox = { WebSocket, Worker, URL, Blob, window: { __nnReport: (r) => reports.push(r) },
        BroadcastChannel: class { postMessage() {} }, location: { href: 'http://h.test/' } };
      sandbox.URL = Object.assign(function U(...a) { return new URL(...a); }, { createObjectURL: () => 'blob:x' });
      sandbox.URL.prototype = URL.prototype;
      sandbox.globalThis = sandbox;
      vm.runInNewContext(hookScript(), sandbox);
      new sandbox.WebSocket().send(JSON.stringify({ secretName: 'secretValue' }));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ method: 'WS-SEND', host: 'h.test', path: '/s/:guid', query: ['k'], bodyKeys: ['secretName'] });
      expect(JSON.stringify(reports)).not.toContain('secretValue');
      new sandbox.Worker('/w.js', { name: 'n' });
      expect(made[0][0]).toBe('blob:x');
      expect(made[0][1]).toEqual({ name: 'n' });
    });
  });
});
