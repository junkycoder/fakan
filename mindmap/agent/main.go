// fakan-agent — daemon, který na vlastním stroji napojí lokální shell
// na fakan tunel přes Cloudflare Worker (TunnelRelay DO).
//
// Subcommands:
//   fakan-agent pair <code> [<machineName>]   — vyměnit pair kód za token
//   fakan-agent run                            — daemon (default subcommand)
//   fakan-agent status                         — zobrazit konfiguraci
//   fakan-agent unpair                         — smazat lokální config
//
// Config v ~/.fakan/agent.json. Token je secret — chraňte soubor přes
// chmod 600 (agent to dělá při saveConfig).

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const defaultEndpoint = "https://fakan-cz.junkycoder.workers.dev"
const reconnectMin = 2 * time.Second
const reconnectMax = 60 * time.Second
const maxOutputBytesPerRun = 5 * 1024 * 1024 // 5 MB

type config struct {
	Endpoint    string `json:"endpoint"`
	MachineID   string `json:"machine_id"`
	MachineName string `json:"machine_name"`
	AgentToken  string `json:"agent_token"`
}

type frame struct {
	Type   string `json:"type"`
	Script string `json:"script,omitempty"`
	Line   string `json:"line,omitempty"`
	Data   string `json:"data,omitempty"`
	Code   int    `json:"code,omitempty"`
	Event  string `json:"event,omitempty"`
}

func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".fakan", "agent.json"), nil
}

func loadConfig() (*config, error) {
	p, err := configPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var c config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", p, err)
	}
	return &c, nil
}

func saveConfig(c *config) error {
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		return err
	}
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if len(os.Args) < 2 {
		cmdRun(os.Args)
		return
	}
	switch os.Args[1] {
	case "pair":
		cmdPair(os.Args[2:])
	case "run":
		cmdRun(os.Args[2:])
	case "status":
		cmdStatus()
	case "unpair":
		cmdUnpair()
	case "help", "-h", "--help":
		printUsage()
	default:
		// nepojmenovaný flag = default run (Linux daemon style)
		cmdRun(os.Args[1:])
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `fakan-agent — daemon pro tunel fakan.cz na vlastní stroj

usage:
  fakan-agent pair <code> [<machineName>]   spárovat s user-strojem
  fakan-agent run                            connect & serve (default)
  fakan-agent status                         info o uložené konfiguraci
  fakan-agent unpair                         smazat config

flags pro run:
  -endpoint URL    přepsat Worker URL (default `+defaultEndpoint+`)
  -v               verbose logging`)
}

// ----- pair -----------------------------------------------------------------

func cmdPair(args []string) {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	endpoint := fs.String("endpoint", defaultEndpoint, "Worker URL")
	fs.Parse(args)
	rest := fs.Args()
	if len(rest) < 1 {
		fmt.Fprintln(os.Stderr, "usage: fakan-agent pair <code> [<machineName>]")
		os.Exit(2)
	}
	code := rest[0]
	name := "unnamed"
	if len(rest) >= 2 {
		name = rest[1]
	}

	body, _ := json.Marshal(map[string]string{
		"code":        code,
		"machineName": name,
	})
	res, err := http.Post(*endpoint+"/api/tunnel/claim", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Fatalf("claim: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		buf, _ := io.ReadAll(res.Body)
		log.Fatalf("claim HTTP %d: %s", res.StatusCode, buf)
	}
	var r struct {
		MachineID   string `json:"machineId"`
		AgentToken  string `json:"agentToken"`
		MachineName string `json:"machineName"`
	}
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		log.Fatalf("decode: %v", err)
	}
	cfg := &config{
		Endpoint:    *endpoint,
		MachineID:   r.MachineID,
		MachineName: r.MachineName,
		AgentToken:  r.AgentToken,
	}
	if err := saveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}
	p, _ := configPath()
	fmt.Printf("Spárováno jako %s (machineId %s)\n", r.MachineName, r.MachineID)
	fmt.Printf("Config: %s (chmod 600)\n", p)
	fmt.Println("\nSpusťte:")
	fmt.Println("  fakan-agent run")
}

// ----- status / unpair ------------------------------------------------------

func cmdStatus() {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "no config: %v\n", err)
		os.Exit(1)
	}
	p, _ := configPath()
	fmt.Printf("Config:      %s\n", p)
	fmt.Printf("Endpoint:    %s\n", cfg.Endpoint)
	fmt.Printf("MachineID:   %s\n", cfg.MachineID)
	fmt.Printf("MachineName: %s\n", cfg.MachineName)
	fmt.Printf("Token:       %s…%s (skryto)\n", cfg.AgentToken[:4], cfg.AgentToken[len(cfg.AgentToken)-4:])
}

func cmdUnpair() {
	p, err := configPath()
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Remove(p); err != nil {
		log.Fatal(err)
	}
	fmt.Println("Config odstraněn. Na user-stroji ještě udělejte `ci tunnel revoke <machineId>`.")
}

// ----- run loop -------------------------------------------------------------

func cmdRun(args []string) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	endpoint := fs.String("endpoint", "", "Worker URL (override config)")
	verbose := fs.Bool("v", false, "verbose")
	fs.Parse(args)
	_ = verbose // pro budoucí use

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("no config — first run `fakan-agent pair <code>`: %v", err)
	}
	if *endpoint != "" {
		cfg.Endpoint = *endpoint
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	backoff := reconnectMin
	for ctx.Err() == nil {
		err := connectAndServe(ctx, cfg)
		if ctx.Err() != nil {
			break
		}
		log.Printf("disconnected: %v; reconnect za %s", err, backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			break
		}
		backoff = nextBackoff(backoff)
	}
	log.Println("agent ukončen")
}

func nextBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > reconnectMax {
		return reconnectMax
	}
	return next
}

func connectAndServe(ctx context.Context, cfg *config) error {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return fmt.Errorf("invalid endpoint: %w", err)
	}
	if u.Scheme == "http" {
		u.Scheme = "ws"
	} else {
		u.Scheme = "wss"
	}
	u.Path = "/api/tunnel/agent"
	q := u.Query()
	q.Set("token", cfg.AgentToken)
	u.RawQuery = q.Encode()

	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(dialCtx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.Close(websocket.StatusInternalError, "shutdown")

	log.Printf("připojen jako %s (%s)", cfg.MachineName, cfg.MachineID)

	// jeden child job najednou — držíme reference pro kill
	var (
		mu         sync.Mutex
		currentCmd *exec.Cmd
	)

	for {
		var f frame
		if err := wsjson.Read(ctx, c, &f); err != nil {
			return err
		}
		switch f.Type {
		case "start":
			mu.Lock()
			if currentCmd != nil {
				mu.Unlock()
				sendFrame(ctx, c, frame{Type: "stderr", Line: "agent: už běží job"})
				sendFrame(ctx, c, frame{Type: "exit", Code: 1})
				continue
			}
			mu.Unlock()
			done := make(chan struct{})
			cmd := startScript(ctx, c, f.Script, done)
			mu.Lock()
			currentCmd = cmd
			mu.Unlock()
			go func() {
				<-done
				mu.Lock()
				currentCmd = nil
				mu.Unlock()
			}()
		case "kill":
			mu.Lock()
			cmd := currentCmd
			mu.Unlock()
			if cmd != nil && cmd.Process != nil {
				_ = cmd.Process.Signal(syscall.SIGTERM)
				go func() {
					time.Sleep(2 * time.Second)
					_ = cmd.Process.Kill()
				}()
			}
		case "stdin":
			// TODO interactive — MVP ignore
		case "resize":
			// TODO PTY — MVP ignore
		default:
			// ignoruj neznámé
		}
	}
}

func startScript(ctx context.Context, c *websocket.Conn, script string, done chan struct{}) *exec.Cmd {
	cmd := exec.Command("bash", "-c", script)
	cmd.Env = append(os.Environ(),
		"FAKAN_AGENT=1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendFrame(ctx, c, frame{Type: "stderr", Line: "pipe stdout: " + err.Error()})
		sendFrame(ctx, c, frame{Type: "exit", Code: 1})
		close(done)
		return nil
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		sendFrame(ctx, c, frame{Type: "stderr", Line: "pipe stderr: " + err.Error()})
		sendFrame(ctx, c, frame{Type: "exit", Code: 1})
		close(done)
		return nil
	}
	if err := cmd.Start(); err != nil {
		sendFrame(ctx, c, frame{Type: "stderr", Line: "start: " + err.Error()})
		sendFrame(ctx, c, frame{Type: "exit", Code: 127})
		close(done)
		return nil
	}

	var bytesOut int
	var bytesMu sync.Mutex
	checkLimit := func(n int) bool {
		bytesMu.Lock()
		defer bytesMu.Unlock()
		bytesOut += n
		return bytesOut <= maxOutputBytesPerRun
	}

	pump := func(r io.Reader, kind string) {
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 64*1024), 1024*1024)
		for s.Scan() {
			ln := s.Text()
			if !checkLimit(len(ln) + 1) {
				_ = cmd.Process.Signal(syscall.SIGTERM)
				sendFrame(ctx, c, frame{Type: "stderr", Line: "agent: output limit překročen (5 MB)"})
				return
			}
			sendFrame(ctx, c, frame{Type: kind, Line: ln})
		}
	}

	go pump(stdout, "stdout")
	go pump(stderr, "stderr")

	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = 1
				sendFrame(ctx, c, frame{Type: "stderr", Line: "wait: " + err.Error()})
			}
		}
		sendFrame(ctx, c, frame{Type: "exit", Code: code})
		close(done)
	}()

	return cmd
}

// sendFrame je goroutine-safe wrapping kolem wsjson.Write
var writeMu sync.Mutex

func sendFrame(ctx context.Context, c *websocket.Conn, f frame) {
	writeMu.Lock()
	defer writeMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_ = wsjson.Write(wctx, c, f)
}
