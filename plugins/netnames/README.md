# netnames

Records the shape of browser requests for allow-listed sessions, so an investigation can see which endpoints a web app calls. Off by default.

Enable in `camofox.config.json` (restart required):

```json
"plugins": { "netnames": { "enabled": true, "userIds": ["agent1"], "maxEntries": 2000, "workerHook": false } }
```

Endpoints (API key or loopback, like other plugins): `GET /plugins/netnames/:userId` returns the buffer; `DELETE` clears it.

## Records

Method, host, path with ids masked (`:guid`, `:thread` for `19:...@thread`, `:hex`, `:b64`, `:num` for 7+ digits), query key names, status, whether the request came from a service worker, top-level JSON body key names for POST/PUT/PATCH. Kept in a ring buffer (default 2000 per user), in memory only.

## Worker hook options

- `workerHookMode: "route"` (use this for real web apps): instead of the blob bootstrap, prepends the wrappers to each worker script response through `context.route` (requests with `Sec-Fetch-Dest` worker, sharedworker or serviceworker). The worker keeps its own URL and `self.location`; the blob bootstrap broke the Teams web client. Limits: blob-URL workers are not routed, and static imports of a module worker run before the prepended code.
- `bodyBooleans: true`: body shapes (`bodyShape`: nested key names with value types, a JSON object carried in a string is opened one level) also show boolean values and integers under 1000 (setting flags and enums). Off by default.
- Records from the hook also carry `headerNames` (lower-case header names, never values) and `bodyShape`.

## Never records

Header values, cookies, tokens, query values, body values (booleans and small integers only with `bodyBooleans`). Nothing is written to disk. The buffer is dropped when the session is destroyed.

## Worker hook (opt-in)

Playwright's Firefox backend does not report fetches made by workers (measured with a local page: dedicated, blob, module, shared and service workers were all missing). Set `"workerHook": true` and the plugin installs an init script that wraps the `Worker` and `SharedWorker` constructors (also from inside workers). Each worker first installs wrappers on `fetch`, `XMLHttpRequest` and `WebSocket.send`, then loads the original script (classic: `importScripts`; module: static import). The page also wraps `WebSocket.send`. Records carry the same names-only shape (WebSocket frames: method `WS-SEND`, top-level keys of JSON frames) with `via` set to `worker` or `page-ws`, and reach the buffer through a same-origin BroadcastChannel and an exposed binding that re-sanitises and re-masks every record.

Limits of the hook:

- Service worker requests are not captured (no constructor to wrap).
- A wrapped worker's `self.location` is a blob URL; relative `fetch`, XHR and `importScripts` URLs are resolved against the original script, other uses of `self.location` see the blob.
- A SharedWorker is no longer shared across tabs (each page makes its own bootstrap blob).
- Request or body objects that are not strings (Request bodies, Blob, ArrayBuffer) give no body key names.
- A page with a Content-Security-Policy that blocks `blob:` workers will not start wrapped workers.

## Limits

Without the hook, Playwright's Worker object has no request events and its Firefox backend attaches network listeners to the page session only, so worker fetches are missing; `fromWorker` is true only for service-worker requests.
