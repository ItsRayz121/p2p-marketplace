/**
 * Body of a rate-limited response. `statusCode` is required: @fastify/rate-limit throws this object as
 * the error, and without it Fastify treated it as an unknown failure and answered 500 "unexpected error"
 * (and the web app, which retries 5xx, retried the request instead of showing its "too many requests" hint).
 * The Retry-After header is set by the plugin itself.
 */
export function rateLimitErrorResponse(_req: unknown, context: { after: string; ttl: number }) {
  return {
    statusCode: 429,
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: `Rate limit exceeded. Retry after ${context.after}.`,
    retryAfter: context.ttl,
  }
}
