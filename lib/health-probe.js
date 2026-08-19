/**
 * Browser liveness probe backed by ONE long-lived context.
 *
 * The original probe called `browser.newContext()`, navigated `about:blank`,
 * then closed both the page and the context -- every few minutes, forever.
 * Inside Docker that was invisible. Running natively against a real display
 * (WSLg) every context is a top-level window, so the liveness check made a
 * window appear on the Windows desktop and vanish again, roughly every three
 * minutes. Reusing one context keeps the check identical from the browser's
 * point of view while creating exactly one window, which can be minimised and
 * ignored.
 *
 * The check itself is unchanged: a real navigation on every probe, so a frozen
 * browser is still detected. Only the context churn is removed.
 */
export function createHealthProbe({ newContext, gotoTimeoutMs = 5000 } = {}) {
  let context = null;
  let page = null;

  // A page belonging to a browser that has since restarted may be closed, or
  // may throw when asked. Either way it is unusable and must be rebuilt.
  function pageUsable() {
    try {
      return !!page && !page.isClosed();
    } catch {
      return false;
    }
  }

  async function teardown() {
    const [p, c] = [page, context];
    page = null;
    context = null;
    if (p) await Promise.resolve(p.close()).catch(() => {});
    if (c) await Promise.resolve(c.close()).catch(() => {});
  }

  async function ensure() {
    if (pageUsable()) return;
    await teardown();
    context = await newContext();
    page = await context.newPage();
  }

  return {
    /**
     * Navigate the probe page. Throws if a freshly built context also fails --
     * the caller treats that as a dead browser and restarts it, so the error
     * must not be swallowed.
     */
    async probe() {
      try {
        await ensure();
        await page.goto('about:blank', { timeout: gotoTimeoutMs });
        return;
      } catch {
        // Fall through: the context may have died with the browser. Rebuild
        // once and let a second failure propagate.
      }
      await teardown();
      await ensure();
      await page.goto('about:blank', { timeout: gotoTimeoutMs });
    },

    dispose: teardown,
  };
}
