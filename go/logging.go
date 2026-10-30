package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/fastly/compute-sdk-go/rtlog"
)

const logEndpointName = "edge-cms-app-logs"

// logLine is the structured record written to the log endpoint (contract 12).
type logLine struct {
	TS         string `json:"ts"`
	Level      string `json:"level"`
	Msg        string `json:"msg"`
	Method     string `json:"method,omitempty"`
	Path       string `json:"path,omitempty"`
	Status     int    `json:"status,omitempty"`
	DurationMS int64  `json:"duration_ms"`
	ClientIP   string `json:"client_ip,omitempty"`
}

// marshalLog renders a log line as JSON.
func marshalLog(l logLine) []byte {
	b, err := json.Marshal(l)
	if err != nil {
		return []byte(`{"level":"error","msg":"log marshal failed"}`)
	}
	return b
}

// emitLog writes to the named log endpoint, falling back to stderr.
func emitLog(l logLine) {
	if l.TS == "" {
		l.TS = time.Now().UTC().Format(time.RFC3339)
	}
	line := append(marshalLog(l), '\n')
	if _, err := rtlog.Open(logEndpointName).Write(line); err != nil {
		os.Stderr.Write(line)
	}
}

// logError records an application error. Callers must never include
// passwords, tokens, cookies or request bodies in msg.
func logError(msg string) {
	emitLog(logLine{Level: "error", Msg: msg})
}

func logErrorf(format string, args ...interface{}) {
	logError(fmt.Sprintf(format, args...))
}

// logRequest records one completed request with a truncated client IP.
func logRequest(method, path string, status int, d time.Duration, ip string) {
	level := "info"
	switch {
	case status >= 500:
		level = "error"
	case status >= 400:
		level = "warn"
	}
	emitLog(logLine{
		Level:      level,
		Msg:        "request",
		Method:     method,
		Path:       path,
		Status:     status,
		DurationMS: d.Milliseconds(),
		ClientIP:   TruncateIP(ip),
	})
}
