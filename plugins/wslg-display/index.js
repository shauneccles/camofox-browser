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


export async function register(_app, ctx) {
  const display = String(process.env.DISPLAY || '').trim();
  if (!display) {
    throw new Error('CAMOFOX_USE_EXISTING_DISPLAY requires DISPLAY to be set');
  }

  ctx.createVirtualDisplay = () => new ExistingDisplay(display);
  ctx.events.on('session:creating', ({ contextOptions }) => {
    delete contextOptions.locale;
    delete contextOptions.timezoneId;
    delete contextOptions.geolocation;
    delete contextOptions.permissions;
  });
  ctx.log('info', 'WSLg display plugin enabled', { display, hostLocale: true });
}
