import { formatLogLine, syslogPrefixEnabled } from '../lib/log.js';

const ON = { CAMOFOX_LOG_SYSLOG_PREFIX: '1' };

describe('syslog priority prefix', () => {
  test('is off unless explicitly enabled', () => {
    expect(syslogPrefixEnabled({})).toBe(false);
    expect(syslogPrefixEnabled({ CAMOFOX_LOG_SYSLOG_PREFIX: '0' })).toBe(false);
    expect(formatLogLine('error', 'boom', {}, {})).not.toMatch(/^</);
  });

  test.each([
    ['error', 3],
    ['warn', 4],
    ['info', 6],
    ['debug', 7],
  ])('maps %s to <%i>', (level, priority) => {
    expect(formatLogLine(level, 'm', {}, ON)).toMatch(new RegExp(`^<${priority}>`));
  });

  test('an unknown level falls back to info rather than throwing', () => {
    expect(formatLogLine('trace', 'm', {}, ON)).toMatch(/^<6>/);
  });

  test('the JSON body is unchanged and still parses once the prefix is stripped', () => {
    const line = formatLogLine('error', 'boom', { reqId: 'abc', code: 500 }, ON);
    const body = line.replace(/^<\d+>/, '');
    expect(JSON.parse(body)).toMatchObject({ level: 'error', msg: 'boom', reqId: 'abc', code: 500 });
  });

  test('no log line can span records, so a prefix cannot be forged mid-message', () => {
    const line = formatLogLine('info', 'a\nb\r\n<3>forged', {}, ON);
    expect(line.split('\n')).toHaveLength(1);
  });
});
