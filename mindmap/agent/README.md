# fakan-agent

Malý Go daemon, který napojí lokální shell vlastního stroje (Raspberry Pi,
domácí Linux box, EC2, …) na fakan terminál v prohlížeči přes Cloudflare
Worker tunel.

## Instalace

Vyžaduje Go 1.22+. Na cílovém stroji:

```bash
git clone https://github.com/junkycoder/fakan
cd fakan/agent
go build -o fakan-agent ./...
sudo install fakan-agent /usr/local/bin/
```

Pro **multi-arch build** (z dev Macu pro Pi/cloud):

```bash
# Raspberry Pi 4/5
GOOS=linux GOARCH=arm64 go build -o fakan-agent-linux-arm64 ./...

# klasický Linux server
GOOS=linux GOARCH=amd64 go build -o fakan-agent-linux-amd64 ./...

# další Mac (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o fakan-agent-darwin-arm64 ./...
```

## Pairing

1. V prohlížeči (https://fakan.cz nebo workers.dev URL):
   ```
   ci token <RUNNER_SECRET>   # pokud ještě neuložený
   ci tunnel pair home-pi
   ```
   Dostanete 6-místný kód, např. `K7M2X9`. Platnost 5 minut.

2. Na cílovém stroji:
   ```bash
   fakan-agent pair K7M2X9 home-pi
   ```
   Agent se připojí k Workeru, vymění kód za long-lived token a uloží do
   `~/.fakan/agent.json` (chmod 600).

3. Spusť daemona:
   ```bash
   fakan-agent run
   ```
   Drží persistent WS k Workeru, automaticky reconnectuje (exponential
   backoff 2s → 60s) když síť selže nebo se Cloudflare DO uspí.

## Použití z prohlížeče

```
ci tunnel machines              # výpis spárovaných strojů
ci tunnel run <machineId> -c "uname -a; uptime; df -h"
ci tunnel run <machineId> ./deploy.sh
```

Skript běží v `bash -c` na cílovém stroji s `FAKAN_AGENT=1` v env.
Stdout/stderr se streamuje řádek po řádku zpět do terminálu v prohlížeči.
Ctrl+C v `ci tunnel run` pošle SIGTERM child procesu (2s grace pak SIGKILL).

## systemd (Linux)

`~/.config/systemd/user/fakan-agent.service`:

```ini
[Unit]
Description=fakan tunnel agent
After=network-online.target

[Service]
ExecStart=/usr/local/bin/fakan-agent run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now fakan-agent
journalctl --user -fu fakan-agent
```

Pro per-machine deploy (nejen user session) si dejte do `/etc/systemd/system/`
a běžte přes dedikovaného uživatele.

## launchd (macOS)

`~/Library/LaunchAgents/cz.fakan.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cz.fakan.agent</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/fakan-agent</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/fakan-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/fakan-agent.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/cz.fakan.agent.plist
```

## Limity

- 5 MB output / run (`maxOutputBytesPerRun` v `main.go`)
- Jeden job najednou — druhý `start` během běhu vrátí error
- Žádný PTY / interaktivní stdin v MVP (přijde s `ci tunnel attach`)

## Bezpečnost

- Token žije v `~/.fakan/agent.json` (mode 600)
- Agent spawnuje `bash -c <script>` s plnou pravomocí uživatele, pod
  kterým běží daemon — co se dá v shellu, dá se přes tunel
- Pro audit log doporučuji systemd journal nebo `tee` do souboru
- Revoke z user-stroje: `ci tunnel revoke <machineId>`. Worker invalidne
  token v KV. Agent při dalším reconnect dostane 401 a vyloggováno
  do journal.
