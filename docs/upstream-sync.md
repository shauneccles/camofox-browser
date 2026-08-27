# Upstream sync — keeping this fork current without losing local fixes

This fork (`talaria-works/camofox-browser`) tracks upstream (`jo-inc/camofox-browser`) while carrying a small set of local commits that have not been upstreamed (WSLg display, VNC setup, and a few pending fixes). The model:

```
main = upstream/master + local commits (rebased on top)
```

Sync = rebase `main` onto `upstream/master`, resolve the known conflicts, test, push. Local changes stay local and stay applied regardless of whether upstream ever accepts them.

## Why rebase, not merge

Rebase keeps the local commits visible at the top of `main` — `git log --oneline upstream/master..main` is exactly "what's ours". It also makes it cheap to drop a local commit once its fix lands upstream. Merge accumulates merge commits and hides the patch set. This is a private fork, so force-pushing a rebased `main` is safe.

`git rerere` is enabled in this repo, so conflict resolutions persist across future syncs.

## The known conflicts (measured 2026-08-27, v1.13.1 -> v1.14.0)

Rebasing the current 7 local commits onto v1.14.0 produced 3 conflicts:

| Local commit | What | Resolution |
|---|---|---|
| `cc74c23` WSLg display | clean | — |
| `740d48c` VNC plugin owns display | clean | — |
| syslog severity (2 commits) | clean | squash the duplicate pair |
| `d067166` node-gyp build deps | conflict (Dockerfile) | already upstreamed — resolve to upstream, drop local |
| `6f11f67` ci hardening | conflict (package.json `test` script + lock) | mechanical — reconcile the test script |
| `4556881` reuse liveness-probe context | conflict (server.js) | substantive — upstream rewrote health-probe (`8ec4b9f` per-user nav health); re-implement or drop |

The Dockerfile resolution is remembered by rerere. The server.js and package.json conflicts need a human decision each sync and are deliberately not auto-resolved.

## Procedure

1. `scripts/sync-upstream.sh` — fetches and reports divergence, lists local commits, and lists any local patches already applied upstream (via `git cherry`).
2. `scripts/sync-upstream.sh --dry-run` — rebases in a throwaway worktree to surface the current conflicts.
3. Resolve by the table above:
   - A local commit whose fix is now upstream → resolve to upstream (drop local). `git cherry upstream/master main` only catches commits whose patch is *identical* upstream (a `-` prefix); a fix upstream adopted in a *different* form (like `d067166`) surfaces as a rebase conflict instead, and the resolution is the same — resolve to upstream.
   - A substantive conflict → re-implement the local intent against the new upstream code, or drop it.
4. Then apply for real:

       git rebase upstream/master main
       npm test
       git push origin main --force-with-lease

## Deploying is separate

Syncing `main` does not deploy anything. The live service runs the checked-out working tree, not `main`. After a sync, deploy by checking out the synced `main`, restarting `camofox-native.service`, and smoke-testing (health, both profiles signed in, localStorage). That step needs the same review and live test as any infrastructure change.
