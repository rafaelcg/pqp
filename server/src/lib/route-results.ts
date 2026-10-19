import { HttpError } from "./http.js";

/**
 * Handler results `handleApi` knows how to answer, for route modules that live
 * outside `api/index.ts` (which would otherwise have to import from the file
 * that imports them). The classes are what `handleApi` tests with
 * `instanceof`, so there is exactly one copy of each.
 */

/** Wrap a handler result to answer 201 instead of 200. */
export class Created {
  constructor(readonly body: unknown) {}
}

/**
 * An `HttpError` whose body carries more than `{ error }`: `detail` is merged
 * into the error envelope, so `error` stays exactly where every client already
 * looks for it.
 */
export class HttpErrorWithDetail extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(status, message);
  }
}
