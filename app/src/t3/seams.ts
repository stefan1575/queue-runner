// The app's doors to T3, each a seam the tests fake (docs/app.md, Rules): HTTP to T3's server
// (sign-in and MCP), a WebSocket to its API, and T3's CLI, which the app starts only to sign in.

export class T3Error extends Error {
  /** T3's typed codes for a failure it answered, outermost first: each `_tag` and `name` down
   *  its cause chain (T3 0.1.9's "never had this thread" is
   *  `OrchestrationV2GetThreadProjectionError` > `OrchestratorProjectionError` >
   *  `ProjectionStoreThreadNotFoundError`). Empty for a failure T3 didn't answer. */
  codes: string[];
  constructor(message: string, codes: string[] = []) {
    super(message);
    this.codes = codes;
  }
}

/** The typed codes down a failure's cause chain (`T3Error.codes`): an Effect Exit's `cause` (one
 *  or a list of `{_tag: "Fail", error}`), then each `error` and `cause` under it. */
export function failureCodes(cause: unknown): string[] {
  const codes: string[] = [];
  const walk = (x: any, depth: number) => {
    if (depth > 12 || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    for (const key of ['_tag', 'name']) {
      const v = x[key];
      if (typeof v === 'string' && !['Fail', 'Die', 'Failure', 'Sequential', 'Parallel', 'Error'].includes(v) && !codes.includes(v)) codes.push(v);
    }
    walk(x.error, depth + 1);
    walk(x.cause, depth + 1);
    walk(x.defect, depth + 1);
  };
  walk(cause, 0);
  return codes;
}

/** T3 refused the token: revoked, expired, or minted for another server. */
export class Unauthorized extends T3Error {}

/** A tool call was sent and no readable answer came back (the connection dropped, T3 answered
 *  5xx, or its answer can't be read): T3 may have done it. A refusal T3 did answer is a plain
 *  T3Error, and so is a failure before the call was sent. */
export class NoAnswer extends T3Error {}

export type HttpRequest = { method: string; headers: Record<string, string>; body?: string };
export type HttpAnswer = { status: number; headers: Record<string, string>; text: string };
/** One HTTP request; throws when the server can't be reached. Header names are lower case. */
export type Http = (url: string, request: HttpRequest) => Promise<HttpAnswer>;

export type CliResult = { code: number; stdout: string; stderr: string };
/** T3's CLI (`t3 <args>`), for signing in only: pairing codes and the app's own sessions. */
export type Cli = (args: string[]) => Promise<CliResult>;

export interface Socket {
  send(text: string): void;
  close(): void;
}
export type SocketEvents = {
  open(): void;
  message(text: string): void;
  /** The socket ended; `opened` says whether it ever opened (a refused upgrade never does). */
  closed(opened: boolean, reason: string): void;
};
/** Opens a WebSocket with these headers; its events arrive through `on`. */
export type Connect = (url: string, headers: Record<string, string>, on: SocketEvents) => Socket;

/** Where T3's server is: its origin, read from server-runtime.json on every connect. */
export type Address = () => Promise<string>;
