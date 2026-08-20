// Structured logging with an optional syslog priority prefix.
//
// systemd does not infer severity from the stream: stdout and stderr both
// arrive at PRIORITY 6. Measured over seven days on the native unit, five
// lines carrying {"level":"error"} produced zero entries at PRIORITY 3, so
// `journalctl -p err -u camofox-native` returned nothing while real errors
// were being logged. journald reads a leading <N> and strips it from MESSAGE,
// leaving the JSON body intact.
//
// Gated behind CAMOFOX_LOG_SYSLOG_PREFIX because this file also ships to npm
// and Docker, where nothing strips the prefix and a log collector parsing the
// line as JSON would fail on it. The native systemd unit sets the variable.

const SYSLOG_PRIORITY = {
  error: 3,
  warn: 4,
  info: 6,
  debug: 7,
};

export function syslogPrefixEnabled(env = process.env) {
  return env.CAMOFOX_LOG_SYSLOG_PREFIX === '1';
}

export function formatLogLine(level, msg, fields = {}, env = process.env) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (!syslogPrefixEnabled(env)) return line;
  const priority = SYSLOG_PRIORITY[level] ?? SYSLOG_PRIORITY.info;
  return `<${priority}>${line}`;
}

export function log(level, msg, fields = {}) {
  const line = formatLogLine(level, msg, fields);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}
