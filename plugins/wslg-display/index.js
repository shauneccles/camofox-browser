class ExistingDisplay {
  constructor(display) {
    this.display = display;
  }

  async get() {
    return this.display;
  }

  kill() {
    // WSLg owns this display. The Camofox server must not stop it.
  }
}

/**
 * Two separable jobs:
 *
 *  1. Reuse an inherited X display instead of starting Xvfb. Needed on WSLg,
 *     where /tmp/.X11-unix is a read-only mount and Xvfb cannot create a
 *     socket. Set `claimDisplay: false` to stand down -- the vnc plugin also
 *     overrides ctx.createVirtualDisplay, and its watcher only attaches x11vnc
 *     to an Xvfb that the node process itself spawned, so when VNC is enabled
 *     it has to own the display.
 *
 *  2. Strip the server's hardcoded en-US / America/Los_Angeles / San Francisco
 *     context overrides. This runs either way. Forcing a US context on
 *     Australian traffic is the exact combination that was observed to stall
 *     Turnstile; let Camoufox and the host supply a consistent one.
 */
export async function register(_app, ctx, pluginConfig = {}) {
  const claimDisplay = pluginConfig.claimDisplay !== false;

  // Validate before touching ctx: failing closed on a missing DISPLAY must not
  // depend on anything else on ctx being present.
  let display = '';
  if (claimDisplay) {
    display = String(process.env.DISPLAY || '').trim();
    if (!display) {
      throw new Error('CAMOFOX_USE_EXISTING_DISPLAY requires DISPLAY to be set');
    }
  }

  ctx.events.on('session:creating', ({ contextOptions }) => {
    delete contextOptions.locale;
    delete contextOptions.timezoneId;
    delete contextOptions.geolocation;
    delete contextOptions.permissions;
  });

  if (!claimDisplay) {
    ctx.log('info', 'WSLg display plugin: context cleanup only, display left to another plugin');
    return;
  }

  ctx.createVirtualDisplay = () => new ExistingDisplay(display);
  ctx.log('info', 'WSLg display plugin enabled', { display, hostLocale: true });
}
