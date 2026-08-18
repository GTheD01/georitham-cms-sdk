/**
 * Failures, sorted by what a caller should do about them.
 *
 * The distinction that earns its keep is between *the CMS did not answer* and
 * *the CMS answered with something wrong*. A build script should shrug at the
 * first — a restart, a network blip, no route from this runner — and keep the
 * content it already has. It must fail loudly at the second, because
 * overwriting good content with a 404 is the actual damage.
 *
 * Every error carries a stable `code` as well as its class. `instanceof` breaks
 * when two copies of a package end up in one dependency tree; a string does not.
 */

export type CmsErrorCode =
  | 'unreachable'
  | 'auth'
  | 'not_found'
  | 'response'
  | 'content'
  | 'config'
  | 'webhook';

export class CmsError extends Error {
  readonly code: CmsErrorCode;

  constructor(code: CmsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** No answer at all: DNS, connection refused, TLS, or a timeout. */
export class CmsUnreachableError extends CmsError {
  readonly url: string;

  constructor(url: string, message: string, options?: { cause?: unknown }) {
    super('unreachable', message, options);
    this.url = url;
  }
}

/** An answer arrived, with a status that is not 2xx. */
export class CmsHttpError extends CmsError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(code: CmsErrorCode, status: number, url: string, message: string, body = '') {
    super(code, message);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 401 or 403 — no token, the wrong token, a revoked one, or a private site. */
export class CmsAuthError extends CmsHttpError {
  /** `hint` names a cause the status alone cannot: a redirect that ate the token. */
  constructor(status: number, url: string, body = '', hint = '') {
    super(
      'auth',
      status,
      url,
      `${status} from ${url} — check the API token, or switch public reads on.${hint}`,
      body,
    );
  }
}

/**
 * 404 — which from out here also means "published in another language" and
 * "still a draft". The API deliberately makes a draft and a missing page look
 * identical, so the message has to cover all three.
 */
export class CmsNotFoundError extends CmsHttpError {
  constructor(url: string, body = '') {
    super(
      'not_found',
      404,
      url,
      `404 from ${url} — is the page published, in that language, under that slug?`,
      body,
    );
  }
}

/** Any other non-2xx: a 500, a proxy's 502, a rate limiter's 429. */
export class CmsResponseError extends CmsHttpError {
  constructor(status: number, url: string, body = '') {
    super('response', status, url, `${status} from ${url}`, body);
  }
}

/**
 * The response was fine as HTTP and wrong as content: not JSON, a payload
 * missing the fields it promises, or a page without the section a site needs.
 */
export class CmsContentError extends CmsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('content', message, options);
  }
}

/** Something the SDK needs was never configured — an origin, a site slug. */
export class CmsConfigError extends CmsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('config', message, options);
  }
}

function hasCode(error: unknown, code: CmsErrorCode): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/** The CMS could not be reached — keep what you have and carry on. */
export function isUnreachable(error: unknown): error is CmsUnreachableError {
  return hasCode(error, 'unreachable');
}

/** The page, or that translation of it, is not published. */
export function isNotFound(error: unknown): error is CmsNotFoundError {
  return hasCode(error, 'not_found');
}

/** The token is missing, wrong, or revoked. */
export function isAuthError(error: unknown): error is CmsAuthError {
  return hasCode(error, 'auth');
}
