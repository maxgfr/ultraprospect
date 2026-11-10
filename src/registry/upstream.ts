// "The register holds no such company" and "the register did not answer" —
// told apart at the one place a connector can still see the difference.
//
// `confirm` counts the two separately: a place a register answered nothing
// about is `notFound`, a place no register could be asked about is `notAsked`,
// and its coverage sentence says which happened. That only works if a connector
// THROWS when it could not ask. Most of them read an HTTP response with
// `res.ok ? res.data : undefined`, so a 503, a timeout and a rate limit all
// came back as "no record" — and a VIES or GLEIF outage in the middle of a run
// reported every company after it as absent from the register.
//
// The lenient reading is kept where it is the right one: a canary and a probe
// REPORT "no answer", so they go on reading a failure as `undefined`.

/** Thrown when a register could not be asked, as opposed to answering nothing. */
export class RegisterUnreachable extends Error {
  constructor(
    readonly connectorId: string,
    detail: string,
  ) {
    super(`${connectorId}: ${detail}`);
    this.name = "RegisterUnreachable";
  }
}

/** The part of an `httpJson` result this reads. */
interface JsonResponse {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
}

/**
 * What a register said, for a caller that must not mistake silence for "no".
 *
 * 404 and 410 are a register's own words for "nothing is filed under that" and
 * come back as `undefined`. Everything else that is not a success — a 5xx, a
 * 429, a refused key, a timeout, which the engine reports as status 0 — is the
 * request failing, and says nothing about the company.
 */
export function registerAnswer(connectorId: string, res: JsonResponse): any {
  if (res.ok) return res.data;
  if (res.status === 404 || res.status === 410) return undefined;
  throw new RegisterUnreachable(connectorId, res.status ? `HTTP ${res.status}` : (res.error ?? "no response"));
}
