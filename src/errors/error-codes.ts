export const ErrorCodes = {
  // 400 - Bad Request
  BAD_REQUEST: { statusCode: 400, message: 'Bad Request' },

  // 401 - Unauthorized
  UNAUTHORIZED: { statusCode: 401, message: 'Unauthorized' },
  MISSING_API_KEY: { statusCode: 401, message: 'Missing X-Api-Key header' },
  INVALID_API_KEY: { statusCode: 401, message: 'Invalid API key' },

  // 404 - Not Found
  NOT_FOUND: { statusCode: 404, message: 'Not Found' },
  ASSISTANT_NOT_FOUND: { statusCode: 404, message: 'Assistant not found' },
  THREAD_NOT_FOUND: { statusCode: 404, message: 'Thread not found' },
  RUN_NOT_FOUND: { statusCode: 404, message: 'Run not found' },
  CRON_NOT_FOUND: { statusCode: 404, message: 'Cron not found' },
  STORE_ITEM_NOT_FOUND: { statusCode: 404, message: 'Store item not found' },

  // 409 - Conflict
  CONFLICT: { statusCode: 409, message: 'Conflict' },
  ASSISTANT_ALREADY_EXISTS: { statusCode: 409, message: 'Assistant already exists' },

  // 422 - Unprocessable Entity
  VALIDATION_ERROR: { statusCode: 422, message: 'Validation Error' },

  // 500 - Internal Server Error
  INTERNAL_ERROR: { statusCode: 500, message: 'Internal Server Error' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;
