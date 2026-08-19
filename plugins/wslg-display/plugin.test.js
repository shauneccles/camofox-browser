import { EventEmitter } from 'events';
import { register } from './index.js';


describe('wslg-display plugin', () => {
  test('uses the inherited display without starting or killing Xvfb', async () => {
    const original = process.env.DISPLAY;
    process.env.DISPLAY = ':0';
    const messages = [];
    const ctx = {
      createVirtualDisplay: () => { throw new Error('Xvfb factory should be replaced'); },
      events: new EventEmitter(),
      log: (level, message, fields) => messages.push({ level, message, fields }),
    };

    await register({}, ctx);
    const display = ctx.createVirtualDisplay();
    const contextOptions = {
      viewport: null,
      permissions: ['geolocation'],
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    };
    ctx.events.emit('session:creating', { contextOptions });

    await expect(display.get()).resolves.toBe(':0');
    expect(display.kill()).toBeUndefined();
    expect(contextOptions.locale).toBeUndefined();
    expect(contextOptions.timezoneId).toBeUndefined();
    expect(contextOptions.geolocation).toBeUndefined();
    expect(contextOptions.permissions).toBeUndefined();
    expect(messages.some(entry => entry.message.includes('WSLg'))).toBe(true);
    process.env.DISPLAY = original;
  });

  test('fails closed when DISPLAY is unavailable', async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    const ctx = { createVirtualDisplay: () => null, log: () => {} };

    await expect(register({}, ctx)).rejects.toThrow('DISPLAY');
    process.env.DISPLAY = original;
  });

  // The vnc plugin also overrides ctx.createVirtualDisplay, and its watcher only
  // attaches x11vnc to an Xvfb that is a child of the node process. When VNC owns
  // the display this plugin must stand down -- but its context cleanup is
  // Turnstile-critical and has to survive.
  test('yields the display when claimDisplay is false', async () => {
    const sentinel = Symbol('untouched');
    const ctx = {
      createVirtualDisplay: () => sentinel,
      events: new EventEmitter(),
      log: () => {},
    };

    await register({}, ctx, { claimDisplay: false });

    expect(ctx.createVirtualDisplay()).toBe(sentinel);
  });

  test('still strips host-contradicting context overrides when claimDisplay is false', async () => {
    const ctx = {
      createVirtualDisplay: () => null,
      events: new EventEmitter(),
      log: () => {},
    };
    await register({}, ctx, { claimDisplay: false });

    const contextOptions = {
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
      permissions: ['geolocation'],
    };
    ctx.events.emit('session:creating', { contextOptions });

    expect(contextOptions.locale).toBeUndefined();
    expect(contextOptions.timezoneId).toBeUndefined();
    expect(contextOptions.geolocation).toBeUndefined();
    expect(contextOptions.permissions).toBeUndefined();
  });

  test('does not require DISPLAY when it is not claiming one', async () => {
    const original = process.env.DISPLAY;
    delete process.env.DISPLAY;
    const ctx = { createVirtualDisplay: () => null, events: new EventEmitter(), log: () => {} };

    await expect(register({}, ctx, { claimDisplay: false })).resolves.toBeUndefined();
    process.env.DISPLAY = original;
  });
});
