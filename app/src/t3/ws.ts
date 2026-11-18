// T3's WebSocket API (`/ws`), as found live (docs/app.md, The WebSocket API): Effect RPC with
// JSON frames. The client sends `{_tag: "Request", id, tag: <method>, payload, headers: []}`; a
// stream answers `{_tag: "Chunk", requestId, values: [...]}`, which the client acks with
// `{_tag: "Ack", requestId}` before the next, and ends with `{_tag: "Exit", requestId, exit}`.
// The upgrade needs `?orchestrationProtocol=2` and a client session's bearer token.
import { T3Error, type Address, type Cli, type Connect, type Http, type Socket } from './seams.ts';
import { signInWebSocket } from './sign-in.ts';

export const ORCHESTRATION_PROTOCOL = 2;

export type Subscription = {
  close(): void;
  /** Settles when the stream ends: resolves on T3's Exit or `close()`, rejects on a failure. */
  done: Promise<void>;
};

export class T3Ws {
  private token: string | null = null;
  private tokenOrigin: string | null = null;
  /** The sign-in under way for each origin, so a call reading another origin never gets its token. */
  private signingIn = new Map<string, Promise<string>>();
  private nextId = 1;

  private address: Address;
  private cli: Cli;
  private http: Http;
  private connect: Connect;

  constructor(address: Address, cli: Cli, http: Http, connect: Connect) {
    this.address = address;
    this.cli = cli;
    this.http = http;
    this.connect = connect;
  }

  /** Subscribes to a stream method; `onValue` gets each value T3 sends. A socket that never
   *  opens (T3 refused the token, or moved) is tried once more on a new sign-in. */
  subscribe(tag: string, payload: object, onValue: (value: any) => void, onExit?: (value: unknown) => void): Subscription {
    let socket: Socket | null = null;
    let closing = false;
    const done = new Promise<void>((resolve, reject) => {
      const attempt = async (n: number) => {
        const origin = await this.address();
        const token = await this.signedIn(origin);
        const id = String(this.nextId++);
        const url = `${origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}`;
        let ended = false;
        const end = (error?: Error) => {
          if (ended) return;
          ended = true;
          socket?.close();
          if (error) reject(error); else resolve();
        };
        socket = this.connect(url, { authorization: `Bearer ${token}` }, {
          open: () => {
            if (closing) return end();
            socket!.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
          },
          message: (text) => {
            let msg;
            try {
              msg = JSON.parse(text);
            } catch {
              return end(new T3Error(`T3 sent an unreadable WebSocket frame: ${text.slice(0, 200)}`));
            }
            if (msg._tag === 'Ping') return socket!.send(JSON.stringify({ _tag: 'Pong' }));
            if (msg._tag === 'Chunk' && msg.requestId === id) {
              for (const v of msg.values ?? []) {
                if (ended || closing) return;
                onValue(v);
              }
              if (!ended && !closing) socket!.send(JSON.stringify({ _tag: 'Ack', requestId: id }));
              return;
            }
            if (msg._tag === 'Exit' && msg.requestId === id) {
              if (msg.exit?._tag === 'Success' && !closing) onExit?.(msg.exit.value);
              return msg.exit?._tag === 'Success'
                ? end()
                : end(new T3Error(`T3 ended ${tag}: ${JSON.stringify(msg.exit?.cause ?? msg.exit).slice(0, 300)}`));
            }
            if (msg._tag === 'Defect' || msg._tag === 'ClientProtocolError') {
              return end(new T3Error(`T3's WebSocket failed ${tag}: ${text.slice(0, 300)}`));
            }
          },
          closed: (opened, reason) => {
            if (ended) return;
            if (closing) return end();
            if (!opened && n === 1) {
              ended = true;
              if (this.token === token) this.token = null;
              attempt(2).catch(reject);
              return;
            }
            end(new T3Error(`T3's WebSocket ${opened ? 'closed' : "didn't open"} at ${url}${reason ? `: ${reason}` : ''}`));
          },
        });
      };
      attempt(1).catch(reject);
    });
    return {
      close: () => { closing = true; socket?.close(); },
      done,
    };
  }

  /** A method that answers once (not a stream): the value of T3's Exit. */
  async request(tag: string, payload: object = {}): Promise<any> {
    let got: unknown;
    const sub = this.subscribe(tag, payload, () => {}, (v) => { got = v; });
    await sub.done;
    return got;
  }

  /** The stream's first value, then the subscription closed. */
  async first(tag: string, payload: object = {}): Promise<any> {
    let got: any;
    let has = false;
    const sub = this.subscribe(tag, payload, (v) => {
      if (has) return;
      got = v;
      has = true;
      sub.close();
    });
    await sub.done;
    if (!has) throw new T3Error(`T3 ended ${tag} without sending anything`);
    return got;
  }

  private async signedIn(origin: string): Promise<string> {
    if (this.token !== null && this.tokenOrigin === origin) return this.token;
    let pending = this.signingIn.get(origin);
    if (!pending) {
      pending = signInWebSocket(origin, this.cli, this.http).then(
        (t) => { this.token = t; this.tokenOrigin = origin; return t; },
      ).finally(() => { this.signingIn.delete(origin); });
      this.signingIn.set(origin, pending);
    }
    return pending;
  }
}
