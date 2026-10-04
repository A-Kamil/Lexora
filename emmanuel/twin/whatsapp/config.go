package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// Config est lue uniquement depuis l'environnement (préfixe TWIN_WA_) : aucune
// valeur codée en dur ailleurs dans le binaire, conformément au CLAUDE.md.
type Config struct {
	DataDir       string // session WhatsApp + messages.db — données T1, jamais versionnées
	Transport     string // "http" (Streamable HTTP, pour le gateway) ou "stdio"
	Listen        string // adresse HTTP ; doit rester sur loopback sauf décision explicite
	AllowSend     bool   // expose send_message ; OFF par défaut (write ⇒ HITL côté gateway)
	FullSync      bool   // demander l'historique complet au moment de l'appairage
	LogLevel      string
	DownloadVoice bool   // télécharger les notes vocales (pour transcription)
	MediaDir      string // où les ranger (T1) ; défaut <DataDir>/media
}

func loadConfig() (Config, error) {
	cfg := Config{
		DataDir:       envOr("TWIN_WA_DATA_DIR", "data"),
		Transport:     strings.ToLower(envOr("TWIN_WA_TRANSPORT", "http")),
		Listen:        envOr("TWIN_WA_LISTEN", "127.0.0.1:8081"),
		AllowSend:     envBool("TWIN_WA_ALLOW_SEND", false),
		FullSync:      envBool("TWIN_WA_FULL_SYNC", true),
		LogLevel:      envOr("TWIN_WA_LOG_LEVEL", "info"),
		DownloadVoice: envBool("TWIN_WA_DOWNLOAD_VOICE", true),
	}
	cfg.MediaDir = envOr("TWIN_WA_MEDIA_DIR", cfg.DataDir+"/media")
	if cfg.Transport != "http" && cfg.Transport != "stdio" {
		return cfg, fmt.Errorf("TWIN_WA_TRANSPORT=%q : attendu http ou stdio", cfg.Transport)
	}
	return cfg, nil
}

// listensOnLoopback signale une exposition réseau non locale : les messages
// sont T1, un bind sur 0.0.0.0 doit être un choix conscient.
func (c Config) listensOnLoopback() bool {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func envBool(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(strings.TrimSpace(v))
	if err != nil {
		return def
	}
	return b
}
