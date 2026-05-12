export class AppError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly statusCode: number = 400,
  ) {
    super(message ?? code)
    this.name = 'AppError'
  }
}

export const Errors = {
  UNAUTHORIZED: () => new AppError('UNAUTHORIZED', 'Authentication required', 401),
  FORBIDDEN: () => new AppError('FORBIDDEN', 'You do not have permission to perform this action', 403),
  NOT_FOUND: (resource = 'Resource') => new AppError('NOT_FOUND', `${resource} not found`, 404),
  VALIDATION_ERROR: (msg: string) => new AppError('VALIDATION_ERROR', msg, 400),
  CONFLICT: (msg: string) => new AppError('CONFLICT', msg, 409),
  RATE_LIMITED: () => new AppError('TOO_MANY_REQUESTS', 'Rate limit exceeded', 429),
  SERVER_ERROR: () => new AppError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', 500),
} as const
