package observability_client_runtime

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

//go:embed config/log_config.json
var packagedConfigJSON []byte

// ConfigVersion is the supported JSON config schema version.
const ConfigVersion = 1

var envPlaceholder = regexp.MustCompile(`\$\{([^}:]+)(?::-([^}]*))?\}`)

var loggingConfigKeys = map[string]struct{}{
	"format":                      {},
	"ensure_tracer_provider":      {},
	"enable_auto_instrumentation": {},
	"enable_auto_span_logging":    {},
	"auto_span_log_level":         {},
	"enable_red_metrics":          {},
	"enable_openllmetry":          {},
	"traceloop_disable_batch":     {},
	"otlp_traces_endpoint":        {},
	"metrics_otlp_endpoint":       {},
	"metrics_service_name":        {},
	"metrics_export_interval_ms":  {},
	"prometheus_metrics_port":     {},
	"prometheus_metrics_host":     {},
	"min_log_level":               {},
	"log_file_path":               {},
	"log_file_encoding":           {},
	"create_log_parent_dirs":      {},
	"write_spans_to_jsonl_file":   {},
	"trace_jsonl_filter":          {},
	"trace_file_path":             {},
	"trace_file_encoding":         {},
}

// LoadLoggingConfigDict parses JSON into kwargs for ObservabilityLoggingConfig.
func LoadLoggingConfigDict(raw map[string]any) (map[string]any, error) {
	version := ConfigVersion
	if v, ok := raw["version"]; ok {
		switch t := v.(type) {
		case float64:
			version = int(t)
		case int:
			version = t
		}
	}
	if version != ConfigVersion {
		return nil, fmt.Errorf("unsupported logging config version %d; expected %d", version, ConfigVersion)
	}

	var loggingCfg map[string]any
	if lg, ok := raw["logging"].(map[string]any); ok {
		loggingCfg = lg
	} else {
		loggingCfg = make(map[string]any)
		for k, v := range raw {
			if k != "version" {
				loggingCfg[k] = v
			}
		}
	}

	for k := range loggingCfg {
		if _, ok := loggingConfigKeys[k]; !ok {
			return nil, fmt.Errorf("unknown logging config key: %s", k)
		}
	}

	expanded := make(map[string]any, len(loggingCfg))
	for k, v := range loggingCfg {
		expanded[k] = expandEnvPlaceholders(v)
	}
	return coerceLoggingKwargsTypes(expanded), nil
}

func expandEnvPlaceholders(value any) any {
	switch t := value.(type) {
	case string:
		return envPlaceholder.ReplaceAllStringFunc(t, func(m string) string {
			sub := envPlaceholder.FindStringSubmatch(m)
			if len(sub) < 2 {
				return m
			}
			name := strings.TrimSpace(sub[1])
			def := ""
			hasDef := len(sub) > 2
			if hasDef {
				def = sub[2]
			}
			env, ok := os.LookupEnv(name)
			if hasDef && (!ok || env == "") {
				return def
			}
			if !ok {
				return ""
			}
			return env
		})
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, v := range t {
			out[k] = expandEnvPlaceholders(v)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, v := range t {
			out[i] = expandEnvPlaceholders(v)
		}
		return out
	default:
		return value
	}
}

func coerceLoggingKwargsTypes(kwargs map[string]any) map[string]any {
	out := make(map[string]any, len(kwargs))
	for k, v := range kwargs {
		out[k] = v
	}
	boolKeys := []string{
		"ensure_tracer_provider", "enable_auto_instrumentation", "enable_auto_span_logging",
		"enable_red_metrics", "enable_openllmetry", "traceloop_disable_batch",
		"create_log_parent_dirs", "write_spans_to_jsonl_file",
	}
	for _, k := range boolKeys {
		if v, ok := out[k]; ok && v != nil {
			out[k] = parseJSONBool(v)
		}
	}
	if v, ok := out["metrics_export_interval_ms"]; ok && v != nil {
		out["metrics_export_interval_ms"] = parseJSONInt(v)
	}
	if v, ok := out["prometheus_metrics_port"]; ok {
		out["prometheus_metrics_port"] = parseJSONIntPtr(v)
	}
	return out
}

func parseJSONBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "true" || s == "1" || s == "yes" || s == "on"
	default:
		return false
	}
}

func parseJSONInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	default:
		return 0
	}
}

func parseJSONIntPtr(v any) any {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok && isNullToken(s) {
		return nil
	}
	n := parseJSONInt(v)
	return n
}

// ConfigureLoggingFromJSONFile loads JSON and applies ConfigureObservabilityLogging.
func ConfigureLoggingFromJSONFile(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	kwargs, err := LoadLoggingConfigDict(raw)
	if err != nil {
		return err
	}
	cfg := ObservabilityStaticDefaults()
	if err := mergeConfigMap(&cfg, kwargs); err != nil {
		return err
	}
	if err := ApplyEnvDefaults(&cfg); err != nil {
		return err
	}
	dir := filepath.Dir(abs)
	if cfg.LogFilePath != "" && !filepath.IsAbs(cfg.LogFilePath) {
		cfg.LogFilePath = filepath.Join(dir, cfg.LogFilePath)
	}
	if cfg.TraceFilePath != nil && !filepath.IsAbs(*cfg.TraceFilePath) {
		p := filepath.Join(dir, *cfg.TraceFilePath)
		cfg.TraceFilePath = &p
	}
	return ConfigureObservabilityLogging(cfg)
}

// ConfigureLoggingFromPackagedDefault loads the bundled log_config.json.
func ConfigureLoggingFromPackagedDefault() error {
	var raw map[string]any
	if err := json.Unmarshal(packagedConfigJSON, &raw); err != nil {
		return err
	}
	kwargs, err := LoadLoggingConfigDict(raw)
	if err != nil {
		return err
	}
	cfg := ObservabilityStaticDefaults()
	if err := mergeConfigMap(&cfg, kwargs); err != nil {
		return err
	}
	if err := ApplyEnvDefaults(&cfg); err != nil {
		return err
	}
	return ConfigureObservabilityLogging(cfg)
}

// ConfigureLoggingFromEnv loads LOG_CONFIG, defaultPath, or packaged default.
func ConfigureLoggingFromEnv(envVar string, defaultPath string, usePackagedDefault bool) error {
	if envVar == "" {
		envVar = "LOG_CONFIG"
	}
	if p := os.Getenv(envVar); p != "" {
		return ConfigureLoggingFromJSONFile(p)
	}
	if defaultPath != "" {
		return ConfigureLoggingFromJSONFile(defaultPath)
	}
	if usePackagedDefault {
		return ConfigureLoggingFromPackagedDefault()
	}
	return nil
}
