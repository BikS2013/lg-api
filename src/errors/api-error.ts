export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public detail?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
