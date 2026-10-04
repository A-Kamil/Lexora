package main

import (
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// Tous les logs partent sur stderr : en transport stdio, stdout est le canal
// JSON-RPC du MCP et ne doit rien recevoir d'autre. Règle CLAUDE.md : on
// journalise des décisions et des compteurs, jamais le contenu des messages.
func newLogger(level string) *slog.Logger {
	var l slog.Level
	switch strings.ToLower(level) {
	case "debug":
		l = slog.LevelDebug
	case "warn", "warning":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

// waLogger adapte slog à l'interface de journalisation de whatsmeow, en
// caviardant ce que whatsmeow laisse passer : ses avertissements recopient
// des nœuds XML entiers (noms affichés, numéros). Vu en prod le 2026-09-05.
type waLogger struct{ l *slog.Logger }

var (
	notifyAttrRE = regexp.MustCompile(`notify="[^"]*"`)
	longDigitsRE = regexp.MustCompile(`\d{8,}`)
)

func redact(s string) string {
	s = notifyAttrRE.ReplaceAllString(s, `notify="…"`)
	return longDigitsRE.ReplaceAllString(s, "<num>")
}

func (w waLogger) Warnf(msg string, args ...any)  { w.l.Warn(redact(fmt.Sprintf(msg, args...))) }
func (w waLogger) Errorf(msg string, args ...any) { w.l.Error(redact(fmt.Sprintf(msg, args...))) }
func (w waLogger) Infof(msg string, args ...any)  { w.l.Info(redact(fmt.Sprintf(msg, args...))) }
func (w waLogger) Debugf(msg string, args ...any) { w.l.Debug(redact(fmt.Sprintf(msg, args...))) }
func (w waLogger) Sub(module string) waLog.Logger { return waLogger{w.l.With("module", module)} }
