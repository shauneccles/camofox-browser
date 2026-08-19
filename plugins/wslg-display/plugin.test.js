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
});
