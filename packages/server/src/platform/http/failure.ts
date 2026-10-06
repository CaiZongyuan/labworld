export class PublicFailure extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503;
  code: string;
  details: Record<string, string>;
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503,
    code: string,
    message: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
