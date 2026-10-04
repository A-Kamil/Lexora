// twin-whatsapp — connecteur MCP WhatsApp du jumeau numérique.
//
// Un seul processus : client WhatsApp (whatsmeow) qui maintient un miroir
// local des messages, et serveur MCP qui l'expose au gateway. Voir README.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		os.Stderr.WriteString("config : " + err.Error() + "\n")
		os.Exit(2)
	}
	log := newLogger(cfg.LogLevel)
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Error("data dir", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := openStore(ctx, filepath.Join(cfg.DataDir, "messages.db"))
	if err != nil {
		log.Error("messages.db", "err", err)
		os.Exit(1)
	}
	defer store.Close()

	bridge, err := newBridge(ctx, cfg, log, store)
	if err != nil {
		log.Error("whatsapp", "err", err)
		os.Exit(1)
	}
	// La connexion (et l'éventuel QR) tourne à côté : le MCP répond tout de
	// suite, sync_status permet de suivre l'appairage depuis le gateway.
	go func() {
		if err := bridge.Connect(ctx); err != nil {
			log.Error("connexion WhatsApp", "err", err)
		}
	}()
	go bridge.watchdog(ctx)
	go bridge.mediaWorker(ctx)
	defer bridge.Disconnect()

	srv := newMCPServer(bridge, cfg)
	log.Info("twin-whatsapp démarré", "version", version, "transport", cfg.Transport,
		"data_dir", cfg.DataDir, "send_enabled", cfg.AllowSend)

	switch cfg.Transport {
	case "stdio":
		if err := srv.Run(ctx, &mcp.StdioTransport{}); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("mcp stdio", "err", err)
			os.Exit(1)
		}
	case "http":
		if !cfg.listensOnLoopback() {
			log.Warn("TWIN_WA_LISTEN n'est pas sur loopback : les messages (T1) sont exposés au réseau",
				"listen", cfg.Listen)
		}
		mux := http.NewServeMux()
		mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(
			func(*http.Request) *mcp.Server { return srv },
			&mcp.StreamableHTTPOptions{Stateless: true}))
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "connected": bridge.connected.Load(), "version": version})
		})
		hs := &http.Server{Addr: cfg.Listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		go func() {
			log.Info("MCP en écoute", "url", "http://"+cfg.Listen+"/mcp")
			if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("http", "err", err)
				stop()
			}
		}()
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hs.Shutdown(shutdownCtx)
	}
	log.Info("arrêt")
}
