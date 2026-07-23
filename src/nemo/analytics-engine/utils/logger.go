package utils

import (
	"log"
	"os"
)

var (
	debugEnabled = os.Getenv("LOG_LEVEL") == "debug"
)

// Debug logs a debug message (only if LOG_LEVEL=debug)
func Debug(format string, v ...interface{}) {
	if debugEnabled {
		log.Printf("[DEBUG] "+format, v...)
	}
}

// Info logs an info message
func Info(format string, v ...interface{}) {
	log.Printf("[INFO] "+format, v...)
}

// Warn logs a warning message
func Warn(format string, v ...interface{}) {
	log.Printf("[WARN] "+format, v...)
}

// Error logs an error message
func Error(format string, v ...interface{}) {
	log.Printf("[ERROR] "+format, v...)
}
