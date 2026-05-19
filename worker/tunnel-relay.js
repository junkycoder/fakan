// Durable Object TunnelRelay — jeden DO instance per machineId, drží dvě
// WebSocket strany (browser + agent) a forwarduje JSON frames mezi nimi.
//
// Bez hibernation API (server.accept() místo state.acceptWebSocket()) — DO
// nezůstává naživu přes spánek. Když agent inaktivní + DO uspí, agent se
// musí reconnect po probuzení (jeho job, exponential backoff).
//
// Frame protokol (JSON, jeden řádek/jeden message):
//   client → server:
//     { type: 'start', script }       browser inicializuje run
//     { type: 'stdin', data }         browser posílá stdin (interactive)
//     { type: 'resize', rows, cols }  browser změnil velikost terminálu
//     { type: 'kill' }                browser zruší
//   server → client:
//     { type: 'stdout'|'stderr', line }
//     { type: 'exit', code }
//     { type: 'system', event: 'agent_offline'|'agent_connected'|... }
//
// Limit: jeden agent slot + jeden browser slot per machineId. Druhý attach
// stejné role odpojí předchozí (LIFO ownership).

import { DurableObject } from 'cloudflare:workers';

export class TunnelRelay extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.agent = null;   // WebSocket | null
    this.browser = null; // WebSocket | null
    this.agentInfo = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role !== 'agent' && role !== 'browser') {
      return new Response('role must be agent|browser', { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attach(server, role);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws, role) {
    if (role === 'agent') {
      if (this.agent) {
        try { this.send(this.agent, { type: 'system', event: 'replaced' }); } catch {}
        try { this.agent.close(1000, 'replaced by newer agent'); } catch {}
      }
      this.agent = ws;
      if (this.browser) this.send(this.browser, { type: 'system', event: 'agent_connected' });
    } else {
      if (this.browser) {
        try { this.send(this.browser, { type: 'system', event: 'replaced' }); } catch {}
        try { this.browser.close(1000, 'replaced'); } catch {}
      }
      this.browser = ws;
      if (!this.agent) {
        this.send(ws, { type: 'system', event: 'agent_offline',
          message: 'na druhé straně tunelu žádný fakan-agent není připojený' });
      } else {
        this.send(ws, { type: 'system', event: 'agent_connected' });
      }
    }

    ws.addEventListener('message', (event) => {
      const other = role === 'agent' ? this.browser : this.agent;
      if (!other) {
        // Pokud druhá strana chybí, browser pošle "agent_offline" odpověď
        // a zavře. Z agenta zprávy bez browseru tiše dropujeme.
        if (role === 'browser') {
          this.send(ws, { type: 'stderr', line: 'agent offline' });
          this.send(ws, { type: 'exit', code: 1 });
          try { ws.close(1000, 'no agent'); } catch {}
        }
        return;
      }
      // Pure passthrough — zprávy jsou už JSON serializované klientem.
      try { other.send(event.data); } catch {}
    });

    ws.addEventListener('close', () => {
      if (role === 'agent') {
        this.agent = null;
        if (this.browser) this.send(this.browser, { type: 'system', event: 'agent_disconnected' });
      } else {
        this.browser = null;
      }
    });

    ws.addEventListener('error', () => {
      // close handler se sám zavolá
    });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}
