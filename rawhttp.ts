// rawhttp.ts — a lean HTTP/1.1 server on node:net, standing in for
// node:http behind the exact contract app.ts uses. The suite's traffic is
// thousands of small keep-alive requests on loopback; llhttp's per-request
// object churn (request/response objects, header maps, URL machinery) cost
// more than the handlers themselves, so this parser does the minimum:
// request line + headers into a flat record, body bytes into one Buffer,
// one socket write per response. Semantics mirror what node:http gave us:
// keep-alive by default on 1.1, content-length framing both ways (chunked
// request bodies are decoded too), 100-continue answered, HEAD answers
// carry headers but no body, and an idle keep-alive socket dies after the
// same 30 s the old server allowed.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

/** One parsed request, the shape app.ts consumes. */
export interface RawRequest {
  method: string;
  /** The request target, exactly as sent (path plus optional query). */
  target: string;
  httpVersion: string;
  /** Header value by lowercase name (first occurrence wins), or undefined. */
  header(name: string): string | undefined;
  /** The whole body, one Buffer (empty when the request had none). */
  body: Buffer;
}

/** The reply app.ts hands back: status, extra headers, body bytes or text. */
export interface RawReply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Emitted as the x-github-request-id header, ahead of `headers`. */
  requestId?: string;
}

/** The one empty body every bodyless request shares (handlers only read). */
const EMPTY_BODY = Buffer.alloc(0);

/** The app handler: synchronous in practice; a promise is also accepted. */
type Handler = (req: RawRequest) => RawReply | Promise<RawReply>;

/** The only request headers anyone in the forge reads. */
const WANTED_HEADERS = new Set([
  'host',
  'authorization',
  'git-protocol',
  'content-length',
  'transfer-encoding',
  'connection',
  'expect',
]);

/** Status-line reason phrases for every status the forge emits. */
const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_HEAD_BYTES = 64 * 1024;
/** The largest request body the forge will read (packs for big pushes). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const KEEP_ALIVE_IDLE_MS = 30_000;

/**
 * The server object main.ts drives: listen(0), address(), once('error'),
 * close(). A structural stand-in for http.Server, nothing more.
 */
export class RawHttpServer extends EventEmitter {
  private readonly net: NetServer;
  private readonly sockets = new Set<Socket>();
  private closing = false;

  constructor(handler: Handler) {
    super();
    this.net = createNetServer((socket) => this.onConnection(socket, handler));
    this.net.on('error', (error) => this.emit('error', error));
  }

  listen(port: number, callback: () => void): void {
    this.net.listen(port, callback);
  }

  address(): { port: number } | null {
    const address = this.net.address();
    return address === null || typeof address === 'string' ? null : { port: address.port };
  }

  close(callback: () => void): void {
    this.closing = true;
    this.net.close(() => callback());
    // Idle keep-alive sockets would otherwise hold close() open; the trial
    // is over when this runs, so drop them all, as Node >= 18.2 does for
    // idle connections.
    for (const socket of this.sockets) socket.destroy();
  }

  private onConnection(socket: Socket, handler: Handler): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(KEEP_ALIVE_IDLE_MS, () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    new Connection(socket, handler).start();
  }
}

/** The reply a handler's own failure produces (app.ts shapes its the same). */
const INTERNAL_ERROR_REPLY: RawReply = {
  status: 500,
  headers: { 'content-type': 'application/json' },
  body: '{"message":"Internal error"}',
};

/** One socket's request/response loop: parse, dispatch, answer, repeat. */
class Connection {
  private readonly socket: Socket;
  private readonly handler: Handler;
  private buffer: Buffer = Buffer.alloc(0);
  private busy = false;
  /** Paused mid-stream: the socket's write buffer has not drained yet. */
  private blocked = false;
  private dead = false;
  /** headEnd offset a 100-continue prompt was already sent for. */
  private continuePromptedFor = -1;

  constructor(socket: Socket, handler: Handler) {
    this.socket = socket;
    this.handler = handler;
  }

  start(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BODY_BYTES + MAX_HEAD_BYTES) {
        this.dead = true;
        this.socket.destroy();
        return;
      }
      this.pump();
    });
  }

  /**
   * Consume as many whole requests as the buffer currently holds. The
   * forge's handler is synchronous, so the common path never leaves the
   * tick: no promise is created per request. A handler that does return
   * a promise (none does today) finishes through the continuation, and a
   * full write buffer pauses the loop until the drain callback resumes
   * it — the same strict request/response serialization as before.
   */
  private pump(): void {
    if (this.busy || this.blocked || this.dead) return;
    this.busy = true;
    try {
      for (;;) {
        const parsed = this.tryParse();
        if (parsed === null) break;
        if (parsed === 'bad') {
          this.dead = true;
          this.socket.destroy();
          break;
        }
        let out: RawReply | Promise<RawReply>;
        try {
          out = this.handler(parsed);
        } catch {
          out = INTERNAL_ERROR_REPLY;
        }
        if (out instanceof Promise) {
          const settle = (reply: RawReply): void => {
            this.busy = false;
            try {
              if (this.writeReply(parsed, reply) === 'ok') this.pump();
            } catch {
              this.dead = true;
              this.socket.destroy();
            }
          };
          out.then(settle, () => settle(INTERNAL_ERROR_REPLY));
          return; // busy stays set until the continuation clears it
        }
        const step = this.writeReply(parsed, out);
        if (step === 'ended') {
          this.dead = true;
          break;
        }
        if (step === 'blocked') break; // the drain callback resumes the loop
      }
    } catch {
      this.dead = true;
      this.socket.destroy();
    }
    this.busy = false;
  }

  /**
   * Parse one request off the front of the buffer, or null when more bytes
   * must arrive first. On success the consumed bytes are removed.
   */
  private tryParse(): (RawRequest & { keepAlive: boolean }) | null | 'bad' {
    const headEnd = this.buffer.indexOf('\r\n\r\n');
    if (headEnd === -1) {
      return this.buffer.length > MAX_HEAD_BYTES ? 'bad' : null;
    }
    const headText = this.buffer.toString('latin1', 0, headEnd);
    const firstBreak = headText.indexOf('\r\n');
    const requestLine = firstBreak === -1 ? headText : headText.slice(0, firstBreak);
    const space1 = requestLine.indexOf(' ');
    const space2 = requestLine.lastIndexOf(' ');
    if (space1 <= 0 || space2 <= space1) return 'bad';
    const method = requestLine.slice(0, space1);
    const target = requestLine.slice(space1 + 1, space2);
    const httpVersion = requestLine.slice(space2 + 1);
    if (!httpVersion.startsWith('HTTP/')) return 'bad';

    // Scan the header block line by line without splitting it into an
    // array of lines first; only the wanted names are ever materialized.
    const headers: Record<string, string | undefined> = {};
    let pos = firstBreak === -1 ? headText.length : firstBreak + 2;
    while (pos < headText.length) {
      const next = headText.indexOf('\r\n', pos);
      const end = next === -1 ? headText.length : next;
      const colon = headText.indexOf(':', pos);
      if (colon > pos && colon < end) {
        const name = headText.slice(pos, colon).trim().toLowerCase();
        if (WANTED_HEADERS.has(name) && headers[name] === undefined) {
          headers[name] = headText.slice(colon + 1, end).trim();
        }
      }
      if (next === -1) break;
      pos = next + 2;
    }

    const bodyStart = headEnd + 4;
    let body: Buffer;
    let consumed: number;
    const transferEncoding = headers['transfer-encoding'];
    if (transferEncoding !== undefined && transferEncoding.toLowerCase().includes('chunked')) {
      const decoded = decodeChunked(this.buffer, bodyStart);
      if (decoded === null) return null;
      if (decoded === 'bad') return 'bad';
      body = decoded.body;
      consumed = decoded.end;
    } else {
      const lengthHeader = headers['content-length'];
      const length = lengthHeader === undefined ? 0 : Number(lengthHeader);
      if (!Number.isInteger(length) || length < 0) return 'bad';
      if (this.buffer.length - bodyStart < length) {
        // A client that announced a body it is still sending after a
        // 100-continue prompt gets the prompt once, when the head lands.
        if (headers['expect']?.toLowerCase() === '100-continue' && this.continuePromptedFor !== headEnd) {
          this.continuePromptedFor = headEnd;
          this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        return null;
      }
      body = length === 0 ? EMPTY_BODY : this.buffer.subarray(bodyStart, bodyStart + length);
      consumed = bodyStart + length;
    }

    const connection = headers['connection']?.toLowerCase() ?? '';
    const keepAlive = httpVersion === 'HTTP/1.0' ? connection === 'keep-alive' : connection !== 'close';
    this.continuePromptedFor = -1;
    this.buffer = consumed >= this.buffer.length ? EMPTY_BODY : this.buffer.subarray(consumed);
    return {
      method,
      target,
      httpVersion,
      header: (name: string) => headers[name],
      body,
      keepAlive,
    };
  }

  /**
   * Write one reply. 'ok' when the loop may continue with the next
   * request, 'blocked' when the write buffer is full (the drain callback
   * resumes the loop), 'ended' when the socket is closing either way.
   */
  private writeReply(req: RawRequest & { keepAlive: boolean }, reply: RawReply): 'ok' | 'blocked' | 'ended' {
    const bodyBuffer =
      reply.body === undefined ? EMPTY_BODY : typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
    let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? ''}\r\n`;
    if (reply.requestId !== undefined) head += `x-github-request-id: ${reply.requestId}\r\n`;
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      head += `${name}: ${value}\r\n`;
    }
    head += `content-length: ${bodyBuffer.length}\r\n`;
    if (!req.keepAlive) head += 'connection: close\r\n';
    head += '\r\n';
    const headBuffer = Buffer.from(head, 'latin1');
    const sendBody = req.method !== 'HEAD' && bodyBuffer.length > 0;
    const payload = sendBody ? Buffer.concat([headBuffer, bodyBuffer]) : headBuffer;
    const flushed = this.socket.write(payload);
    if (!req.keepAlive) {
      this.socket.end();
      return 'ended';
    }
    if (!flushed) {
      this.blocked = true;
      this.socket.once('drain', () => {
        this.blocked = false;
        this.pump();
      });
      return 'blocked';
    }
    return 'ok';
  }
}

/** Decode a chunked body starting at `start`; null while incomplete. */
function decodeChunked(buffer: Buffer, start: number): { body: Buffer; end: number } | null | 'bad' {
  const chunks: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const sizeText = buffer.toString('latin1', offset, lineEnd).split(';', 1)[0]!.trim();
    const size = parseInt(sizeText, 16);
    if (Number.isNaN(size) || size < 0) return 'bad';
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailer part: ends at the first empty line.
      const trailerEnd = buffer.indexOf('\r\n', dataStart);
      if (trailerEnd === -1) return null;
      if (trailerEnd === dataStart) return { body: Buffer.concat(chunks), end: dataStart + 2 };
      const rest = buffer.indexOf('\r\n\r\n', dataStart);
      if (rest === -1) return null;
      return { body: Buffer.concat(chunks), end: rest + 4 };
    }
    if (buffer.length - dataStart < size + 2) return null;
    chunks.push(buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
}
