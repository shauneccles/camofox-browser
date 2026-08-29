/**
 * Periodic storage-state checkpointing.
 *
 * The persistence plugin writes storage state on five events -- session
 * teardown, server shutdown, cookie import, bootstrap-cookie import, and an
 * explicit storage export -- and on no timer. A session that lives a long time
 * and then dies ungracefully (SIGKILL, OOM, browser crash, host reboot) loses
 * every cookie it earned. With a long SESSION_TIMEOUT_MS, which is what you set
 * for an aged authenticated profile, that window is the whole day.
 *
 * This closes it from OUTSIDE core. Upstream considered timer-based
 * checkpointing in core and declined it (jo-inc/camofox-browser#7223, closed
 * unmerged) on the grounds that it "adds continuous serialization and
 * coordination even when storage hasn't changed", and suggested it would work
 * as a separate plugin instead. This is that plugin: it uses only the public
 * plugin context, so it rebases cleanly and does not fork core.
 *
 * It emits the SAME event the vnc plugin's GET /sessions/:userId/storage_state
 * emits, so the persistence plugin does the actual writing and there is exactly
 * one code path that touches the profile on disk. It also means checkpointing
 * no longer depends on the vnc plugin being enabled -- which upstream ships
 * disabled by default, and which was previously the only way to force one.
 *
 * Off unless configured:
 *
 *   "plugins": { "persistence-interval": { "enabled": true, "intervalMs": 300000 } }
 */
export async function register(_app, ctx, pluginConfig = {}) {
  const { events, sessions, log } = ctx;

  // Note `Number(...) || 0` rather than the `parseInt(env) || default` idiom
  // used elsewhere in this codebase: there, a zero silently restores the
  // default. Here zero must mean OFF, because "checkpoint every 0ms" has no
  // sensible reading and a surprise default would be a busy loop.
  const intervalMs = Number(pluginConfig.intervalMs) || 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    log('info', 'persistence-interval plugin: disabled (set plugins["persistence-interval"].intervalMs)');
    return;
  }

  const checkpointAll = async () => {
    // Snapshot the entries first: a session destroyed mid-loop would otherwise
    // mutate the Map we are iterating.
    for (const [userId, session] of [...sessions.entries()]) {
      try {
        const state = await session?.context?.storageState(ctx.persistenceStorageStateOptions);
        if (!state) continue;
        await events.emitAsync('session:storage:export', {
          userId: String(userId),
          storageState: state,
        });
      } catch (err) {
        // A dead or closing context is expected and routine. Swallow it per
        // session: one bad context must not skip the others, and must not kill
        // the timer -- a browser that just died is precisely when the remaining
        // sessions' accumulated state is most worth saving.
        log('warn', 'persistence-interval: checkpoint failed', {
          userId: String(userId),
          error: err?.message || String(err),
        });
      }
    }
  };

  const timer = setInterval(() => { void checkpointAll(); }, intervalMs);
  // Do not hold the event loop open: the checkpoint is a nicety, not a reason
  // for the process to refuse to exit.
  timer.unref?.();

  events.on('server:shutdown', () => clearInterval(timer));

  log('info', 'persistence-interval plugin enabled', { intervalMs });
}
