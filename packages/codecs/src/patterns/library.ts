import { PatternRegistry } from './engine.js';

/**
 * A ready-made {@link PatternRegistry} covering common log-line building blocks and a few whole
 * line formats. Extend it for an application's own formats:
 * ```ts
 * const mine = new PatternRegistry(builtinPatterns).define('MY_LINE', '%{TIMESTAMP_ISO8601:ts} %{GREEDYDATA:msg}');
 * ```
 */
export const builtinPatterns = new PatternRegistry();

builtinPatterns
  // --- primitives ---------------------------------------------------------------------------
  .define('INT', String.raw`[+-]?\d+`)
  .define('NUMBER', String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`)
  .define('WORD', String.raw`\b\w+\b`)
  .define('NOTSPACE', String.raw`\S+`)
  .define('SPACE', String.raw`\s*`)
  .define('DATA', String.raw`.*?`)
  .define('GREEDYDATA', String.raw`.*`)
  .define('QUOTEDSTRING', String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`)
  // --- network --------------------------------------------------------------------------------
  .define(
    'IPV4',
    String.raw`(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`,
  )
  .define(
    'IPV6',
    // All nine canonical textual forms (RFC 5952), including the zone-ID suffix on link-local
    // addresses and the dotted-quad tail of an IPv4-mapped address. Every quantifier is bounded
    // ({m,n}), so there is no nested-unbounded-wildcard backtracking risk.
    String.raw`(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,7}:` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}` +
      String.raw`|[0-9A-Fa-f]{1,4}:(?:(?::[0-9A-Fa-f]{1,4}){1,6})` +
      String.raw`|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)` +
      String.raw`|fe80:(?::[0-9A-Fa-f]{0,4}){0,4}%[0-9a-zA-Z]+` +
      String.raw`|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)` +
      String.raw`|(?:[0-9A-Fa-f]{1,4}:){1,4}:(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)`,
  )
  .define('IP', String.raw`%{IPV6}|%{IPV4}`)
  .define(
    'HOSTNAME',
    String.raw`\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\b`,
  )
  .define('IPORHOST', String.raw`%{IP}|%{HOSTNAME}`)
  .define('PORT', String.raw`[0-9]{1,5}`)
  .define(
    'UUID',
    String.raw`[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}`,
  )
  .define('MAC', String.raw`(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}`)
  .define('EMAIL', String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
  .define('PATH', String.raw`/\S*`)
  .define('WINDOWS_PATH', String.raw`[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*`)
  // --- misc -------------------------------------------------------------------------------------
  .define(
    'LOGLEVEL',
    String.raw`(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERR(?:OR)?|CRIT(?:ICAL)?|FATAL|EMERG(?:ENCY)?|ALERT)`,
  )
  .define('DURATION', String.raw`%{NUMBER}(?:ns|us|µs|ms|s|m|h|d)`)
  // --- time -------------------------------------------------------------------------------------
  .define('YEAR', String.raw`\d{4}`)
  .define('MONTHNUM', String.raw`0[1-9]|1[0-2]`)
  .define('MONTHDAY', String.raw`0[1-9]|[12]\d|3[01]|[1-9]`)
  .define(
    'MONTH',
    String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`,
  )
  .define('HOUR', String.raw`[01]\d|2[0-3]`)
  .define('MINUTE', String.raw`[0-5]\d`)
  .define('SECOND', String.raw`[0-5]\d(?:\.\d+)?`)
  .define('TIME', String.raw`%{HOUR}:%{MINUTE}(?::%{SECOND})?`)
  .define('INT_TZ', String.raw`[+-]%{HOUR}%{MINUTE}`)
  .define(
    'TIMESTAMP_ISO8601',
    String.raw`%{YEAR}-%{MONTHNUM}-%{MONTHDAY}[T ]%{TIME}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`,
  )
  .define('HTTPDATE', String.raw`%{MONTHDAY}/%{MONTH}/%{YEAR}:%{TIME} %{INT_TZ}`)
  // --- HTTP -------------------------------------------------------------------------------------
  .define('HTTPMETHOD', String.raw`GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE|CONNECT`)
  .define('URIPROTO', String.raw`[A-Za-z][A-Za-z0-9+.-]*`)
  .define('URIPATH', String.raw`[A-Za-z0-9$.+!*'(){},~:;=@#%_\-\/]+`)
  .define('URIQUERY', String.raw`[^ "]*`)
  .define(
    'URI',
    String.raw`%{URIPROTO}://(?:%{USER}(?::[^@]*)?@)?(?:%{IPORHOST})(?::%{PORT})?(?:%{URIPATH})?(?:\?%{URIQUERY})?|%{URIPATH}(?:\?%{URIQUERY})?`,
  )
  .define('USER', String.raw`[A-Za-z0-9._-]+`)
  // --- whole-line formats -------------------------------------------------------------------------
  .define(
    'COMMONAPACHELOG',
    String.raw`%{IPORHOST:clientip} %{NOTSPACE:ident} %{NOTSPACE:auth} \[%{HTTPDATE:timestamp}\] "(?:%{HTTPMETHOD:verb} %{NOTSPACE:request}(?: HTTP/%{NUMBER:httpversion})?|%{DATA:rawrequest})" %{INT:response} (?:-|%{INT:bytes})`,
  )
  .define('COMBINEDAPACHELOG', String.raw`%{COMMONAPACHELOG} "%{DATA:referrer}" "%{DATA:agent}"`)
  .define(
    'NGINXACCESSLOG',
    String.raw`%{IPORHOST:clientip} - %{NOTSPACE:remote_user} \[%{HTTPDATE:timestamp}\] "%{HTTPMETHOD:verb} %{NOTSPACE:request} HTTP/%{NUMBER:httpversion}" %{INT:response} %{INT:bytes} "%{DATA:referrer}" "%{DATA:agent}"`,
  )
  .define('SYSLOGTIMESTAMP', String.raw`%{MONTH} +%{MONTHDAY} %{TIME}`)
  .define(
    'SYSLOGLINE',
    String.raw`%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}(?:\[%{INT:pid}\])?: %{GREEDYDATA:message}`,
  );
