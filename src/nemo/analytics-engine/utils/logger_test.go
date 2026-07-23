package utils

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
)

func TestInfo(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	Info("hello %s", "world")
	if !strings.Contains(buf.String(), "[INFO]") {
		t.Errorf("expected [INFO] in output, got: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "hello world") {
		t.Errorf("expected message in output, got: %q", buf.String())
	}
}

func TestWarn(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	Warn("something %d", 42)
	if !strings.Contains(buf.String(), "[WARN]") {
		t.Errorf("expected [WARN] in output, got: %q", buf.String())
	}
}

func TestError(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	Error("bad thing: %v", "oops")
	if !strings.Contains(buf.String(), "[ERROR]") {
		t.Errorf("expected [ERROR] in output, got: %q", buf.String())
	}
}

func TestDebug_Suppressed(t *testing.T) {
	// Save and restore both the env var and the package-level flag so this
	// test does not leak state into other tests.
	oldEnv, hadEnv := os.LookupEnv("LOG_LEVEL")
	oldFlag := debugEnabled
	t.Cleanup(func() {
		if hadEnv {
			os.Setenv("LOG_LEVEL", oldEnv)
		} else {
			os.Unsetenv("LOG_LEVEL")
		}
		debugEnabled = oldFlag
	})

	os.Unsetenv("LOG_LEVEL")
	debugEnabled = false

	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	Debug("should not appear")
	if strings.Contains(buf.String(), "[DEBUG]") {
		t.Errorf("debug output should be suppressed when LOG_LEVEL != debug, got: %q", buf.String())
	}
}

func TestDebug_Enabled(t *testing.T) {
	// Temporarily enable debug
	old := debugEnabled
	debugEnabled = true
	defer func() { debugEnabled = old }()

	var buf bytes.Buffer
	oldW := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(oldW)

	Debug("visible %s", "message")
	if !strings.Contains(buf.String(), "[DEBUG]") {
		t.Errorf("expected [DEBUG] in output when enabled, got: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "visible message") {
		t.Errorf("expected message content, got: %q", buf.String())
	}
}
