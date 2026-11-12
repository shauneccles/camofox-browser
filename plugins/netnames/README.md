# netnames

Records the shape of browser requests for allow-listed sessions, so an investigation can see which endpoints a web app calls. Off by default.

Enable in `camofox.config.json` (restart required):

```json
"plugins": { "netnames": { "enabled": true, "userIds": ["agent1"], "maxEntries": 2000 } }
```

Endpoints (API key or loopback, like other plugins): `GET /plugins/netnames/:userId` returns the buffer; `DELETE` clears it.

## Records

Method, host, path with ids masked (`:guid`, `:thread` for `19:...@thread`, `:hex`, `:b64`, `:num` for 7+ digits), query key names, status, whether the request came from a service worker, top-level JSON body key names for POST/PUT/PATCH. Kept in a ring buffer (default 2000 per user), in memory only.

## Never records

Headers, cookies, tokens, query values, body values. Nothing is written to disk. The buffer is dropped when the session is destroyed.

## Limits

Playwright's Worker object has no request events, and its Firefox backend attaches network listeners to the page session only. Dedicated-worker fetches may therefore be missing; `fromWorker` is true only for service-worker requests.
