/**
 * Ferrule's admin API: an embeddable HTTP server exposing health, topology, internal metrics,
 * per-component detail, a live event tap, a redacted config dump, and hot reload, plus a typed
 * client for consuming it. See the package README for the endpoint reference.
 */

export {
  AdminError,
  BadRequestError,
  ForbiddenHostError,
  MethodNotAllowedError,
  NotConfiguredError,
  NotFoundError,
  PayloadTooLargeError,
  RequestTimeoutError,
  UnauthorizedError,
} from './errors.js';
export type {
  AdminAuthOptions,
  AdminServer,
  AdminServerOptions,
  AdminTapOptions,
  BoundAddress,
  ComponentDetail,
  MetricEventJson,
  MetricValueJson,
} from './types.js';
export { createAdminServer } from './server.js';
export {
  AdminClient,
  AdminClientError,
  type AdminClientOptions,
  type ClientTapOptions,
} from './client.js';
export { eventToValue } from './event-json.js';
export { metricEventToJson } from './metrics-json.js';
export { renderDot, renderMermaid } from './topology-render.js';
