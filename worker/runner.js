// HTTP server uvnitř kontejneru — spustí bash skript a streamuje výstup.
// Worker forwarduje WebSocket z prohlížeče sem přes Cloudflare Containers
// binding. Skript přichází jako POST /run s body { script: "..." }.
//
// Odpověď je NDJSON (newline-delimited JSON), jeden objekt per řádek:
//   { type: "stdout"|"stderr", line: "..." }
//   { type: "exit", code: N }

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 300_000);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES || 1_048_576); // 1 MB

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runner: 'container', ts: Date.now() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    return handleRun(req, res);
  }

  res.writeHead(404);
  res.end();
});

function emit(res, obj) {
  try { res.write(JSON.stringify(obj) + '\n'); } catch {}
}

function streamLines(buffer, onLine) {
  let out = '';
  return (chunk) => {
    out += chunk.toString('utf-8');
    const lines = out.split('\n');
    out = lines.pop(); // poslední (nemusí být dokončený) zachovej v bufferu
    for (const ln of lines) onLine(ln);
  };
}

function handleRun(req, res) {
  let body = '';
  let totalBytes = 0;

  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 256 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); res.end('invalid JSON'); return; }
    const script = String(parsed.script || '');

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });

    const child = spawn('bash', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // sandbox: žádný náhodný stav z parent procesu
        HOME: '/tmp',
        USER: 'fakan',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      timeout: MAX_RUNTIME_MS, // Node kill po překročení
    });

    let killed = false;
    function killChild(reason) {
      if (killed) return;
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
      emit(res, { type: 'stderr', line: reason });
    }

    const stdoutHandler = streamLines(null, (ln) => {
      totalBytes += ln.length + 1;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        killChild('output limit překročen (1 MB)');
        return;
      }
      emit(res, { type: 'stdout', line: ln });
    });
    const stderrHandler = streamLines(null, (ln) => {
      totalBytes += ln.length + 1;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        killChild('output limit překročen (1 MB)');
        return;
      }
      emit(res, { type: 'stderr', line: ln });
    });

    child.stdout.on('data', stdoutHandler);
    child.stderr.on('data', stderrHandler);

    child.on('close', (code, signal) => {
      let exitCode = typeof code === 'number' ? code : 1;
      if (signal === 'SIGTERM' && !killed) {
        emit(res, { type: 'stderr', line: 'timeout' });
        exitCode = 124;
      }
      emit(res, { type: 'exit', code: exitCode });
      try { res.end(); } catch {}
    });
    child.on('error', (e) => {
      emit(res, { type: 'stderr', line: 'spawn error: ' + e.message });
      emit(res, { type: 'exit', code: 127 });
      try { res.end(); } catch {}
    });

    // klient se odpojil → kill child
    req.on('close', () => {
      if (!child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`[fakan-runner] listening on :${PORT}, max ${MAX_RUNTIME_MS}ms, max ${MAX_OUTPUT_BYTES}B`);
});
