package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestGetEnv_DefaultAndOverride(t *testing.T) {
	t.Setenv("TEST_GET_ENV", "")
	assert.Equal(t, "default", getEnv("TEST_GET_ENV", "default"))
	t.Setenv("TEST_GET_ENV", "custom")
	assert.Equal(t, "custom", getEnv("TEST_GET_ENV", "default"))
}

func TestGetEnvInt_ValidAndInvalid(t *testing.T) {
	t.Setenv("TEST_GET_ENV_INT", "")
	assert.Equal(t, 42, getEnvInt("TEST_GET_ENV_INT", 42))
	t.Setenv("TEST_GET_ENV_INT", "7")
	assert.Equal(t, 7, getEnvInt("TEST_GET_ENV_INT", 42))
	t.Setenv("TEST_GET_ENV_INT", "not-a-number")
	assert.Equal(t, 42, getEnvInt("TEST_GET_ENV_INT", 42))
}

func TestParseDurationEnv_ValidInvalidAndZero(t *testing.T) {
	def := 10 * time.Minute
	t.Setenv("TEST_PARSE_DUR", "")
	assert.Equal(t, def, parseDurationEnv("TEST_PARSE_DUR", def))
	t.Setenv("TEST_PARSE_DUR", "30s")
	assert.Equal(t, 30*time.Second, parseDurationEnv("TEST_PARSE_DUR", def))
	t.Setenv("TEST_PARSE_DUR", "garbage")
	assert.Equal(t, def, parseDurationEnv("TEST_PARSE_DUR", def))
	t.Setenv("TEST_PARSE_DUR", "0s")
	assert.Equal(t, def, parseDurationEnv("TEST_PARSE_DUR", def))
}

func TestGetEnvBool_TruthyAndFalsy(t *testing.T) {
	t.Setenv("TEST_GET_ENV_BOOL", "")
	assert.True(t, getEnvBool("TEST_GET_ENV_BOOL", true))
	assert.False(t, getEnvBool("TEST_GET_ENV_BOOL", false))

	truthy := []string{"1", "true", "TRUE", "True", "yes", "YES", "on", "ON"}
	for _, v := range truthy {
		t.Setenv("TEST_GET_ENV_BOOL", v)
		assert.True(t, getEnvBool("TEST_GET_ENV_BOOL", false), "value=%q", v)
	}
	falsy := []string{"0", "false", "FALSE", "False", "no", "NO", "off", "OFF"}
	for _, v := range falsy {
		t.Setenv("TEST_GET_ENV_BOOL", v)
		assert.False(t, getEnvBool("TEST_GET_ENV_BOOL", true), "value=%q", v)
	}
	t.Setenv("TEST_GET_ENV_BOOL", "maybe")
	assert.True(t, getEnvBool("TEST_GET_ENV_BOOL", true))
}

func TestSplitAndTrim(t *testing.T) {
	assert.Nil(t, splitAndTrim("", ","))
	assert.Equal(t, []string{"a", "b", "c"}, splitAndTrim(" a , b ,, c ", ","))
	assert.Equal(t, []string{"host1", "host2"}, splitAndTrim("host1, host2", ","))
}
