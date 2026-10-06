/** The caller sent something wrong — 400, not our fault, not worth a stack trace. */
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
    this.status = 400;
  }
}

/** The shared daily/monthly budget is used up. Cached answers still work; new research waits. */
export class BudgetExceeded extends Error {
  constructor(message, { retryAfterS } = {}) {
    super(message);
    this.name = 'BudgetExceeded';
    this.status = 503;
    this.retryAfterS = retryAfterS;
  }
}

/** Tavily or the LLM failed. Surfaced as 502 so the caller can tell it apart from a bad request. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, body } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
  }
}
