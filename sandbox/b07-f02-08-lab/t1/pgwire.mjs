// Cliente mínimo do protocolo do PostgreSQL (v3) para o teste T1, sem dependências (o runner não instala
// pacotes npm). Só autenticação trust em 127.0.0.1 de um cluster efêmero. query() usa o protocolo ESTENDIDO
// (Parse/Bind/Execute/Sync) com parâmetros em texto, como o driver do Worker envia uma instrução parametrizada.
import net from 'node:net';

export class PgError extends Error {
  constructor(fields) { super(fields.M || 'erro'); this.code = fields.C; this.fields = fields; }
}

export function connect({ host = '127.0.0.1', port, user = 'postgres', database = 'postgres' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0), waiter = null, ready = false;
    const queue = [];
    const pump = () => {
      while (buf.length >= 5) {
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) break;
        const msg = { type: String.fromCharCode(buf[0]), body: buf.subarray(5, len + 1) };
        buf = buf.subarray(len + 1);
        queue.push(msg);
      }
      if (waiter && queue.length) { const w = waiter; waiter = null; w(); }
    };
    const next = () => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      if (sock.destroyed) return rej(new Error('conexão fechada'));
      waiter = () => res(queue.shift());
    });
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on('error', (e) => { if (!ready) reject(e); });
    const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
    const frame = (type, body) => {
      const head = Buffer.alloc(type ? 5 : 4);
      if (type) { head.write(type, 0, 'latin1'); head.writeInt32BE(body.length + 4, 1); }
      else head.writeInt32BE(body.length + 4, 0);
      return Buffer.concat([head, body]);
    };
    const parseFields = (body) => {
      const f = {}; let i = 0;
      while (i < body.length && body[i] !== 0) {
        const k = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1);
        f[k] = body.subarray(i + 1, end).toString('utf8'); i = end + 1;
      }
      return f;
    };
    // Lê até ReadyForQuery; devolve linhas (objetos de texto), avisos e o primeiro erro.
    const collect = async () => {
      let cols = [], rows = [], err = null; const notices = [];
      for (;;) {
        const m = await next();
        if (m.type === 'T') {
          cols = []; const n = m.body.readInt16BE(0); let i = 2;
          for (let k = 0; k < n; k++) { const end = m.body.indexOf(0, i); cols.push(m.body.subarray(i, end).toString('utf8')); i = end + 19; }
        } else if (m.type === 'D') {
          const n = m.body.readInt16BE(0); let i = 2; const row = {};
          for (let k = 0; k < n; k++) {
            const l = m.body.readInt32BE(i); i += 4;
            row[cols[k]] = l < 0 ? null : m.body.subarray(i, i + l).toString('utf8'); if (l > 0) i += l;
          }
          rows.push(row);
        } else if (m.type === 'E') { err = err || new PgError(parseFields(m.body)); }
        else if (m.type === 'N') { notices.push(parseFields(m.body)); }
        else if (m.type === 'Z') { if (err) { err.notices = notices; throw err; } rows.notices = notices; return rows; }
      }
    };
    sock.on('connect', async () => {
      try {
        const params = Buffer.concat([cstr('user'), cstr(user), cstr('database'), cstr(database), Buffer.from([0])]);
        const ver = Buffer.alloc(4); ver.writeInt32BE(196608);
        sock.write(frame(null, Buffer.concat([ver, params])));
        for (;;) {
          const m = await next();
          if (m.type === 'R' && m.body.readInt32BE(0) !== 0) throw new Error('só autenticação trust é suportada');
          if (m.type === 'E') throw new PgError(parseFields(m.body));
          if (m.type === 'Z') break;
        }
        ready = true;
        const client = {
          async query(text, values = []) {
            const p = Buffer.concat([cstr(''), cstr(text), Buffer.from([0, 0])]);
            const parts = [cstr(''), cstr(''), Buffer.from([0, 0])];
            const n = Buffer.alloc(2); n.writeInt16BE(values.length); parts.push(n);
            for (const v of values) {
              if (v === null || v === undefined) { const b = Buffer.alloc(4); b.writeInt32BE(-1); parts.push(b); }
              else { const vb = Buffer.from(String(v), 'utf8'); const b = Buffer.alloc(4); b.writeInt32BE(vb.length); parts.push(b, vb); }
            }
            parts.push(Buffer.from([0, 0]));
            sock.write(Buffer.concat([frame('P', p), frame('B', Buffer.concat(parts)),
              frame('D', Buffer.concat([Buffer.from('P'), cstr('')])), frame('E', Buffer.concat([cstr(''), Buffer.from([0, 0, 0, 0])])),
              frame('S', Buffer.alloc(0))]));
            return collect();
          },
          async simple(text) { sock.write(frame('Q', cstr(text))); return collect(); },
          close() { try { sock.write(frame('X', Buffer.alloc(0))); } catch {} sock.end(); },
        };
        resolve(client);
      } catch (e) { sock.destroy(); reject(e); }
    });
  });
}
