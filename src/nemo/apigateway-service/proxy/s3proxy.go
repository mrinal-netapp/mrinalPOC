package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"
	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

var (
	s3Signer    *v4.Signer
	s3AccessKey string
	s3SecretKey string
	s3Region    string
	s3DebugLog  bool
)

// debugLog logs a message only if S3_DEBUG environment variable is set
func debugLog(ctx context.Context, msg string, fields ...obslib.LogField) {
	if s3DebugLog {
		obslib.LogDebug(ctx, msg, fields...)
	}
}

var encodedSlashPattern = regexp.MustCompile(`(?i)%2f`)

func hasInboundSigV4(req *http.Request) bool {
	auth := req.Header.Get("Authorization")
	if strings.HasPrefix(auth, "AWS4-HMAC-SHA256") {
		return true
	}
	// Support query-string presign flow too.
	q := req.URL.Query()
	if q.Get("X-Amz-Signature") != "" || q.Get("X-Amz-Algorithm") != "" {
		return true
	}
	return false
}

func decodePathSegmentPreserveEncodedSlash(segment string) string {
	protected := encodedSlashPattern.ReplaceAllString(segment, "__PERCENT_2F__")
	decoded, err := url.PathUnescape(protected)
	if err != nil {
		return segment
	}
	return strings.ReplaceAll(decoded, "__PERCENT_2F__", "%2F")
}

func canonicalizeS3Path(in *url.URL) (string, string) {
	sourcePath := in.RawPath
	if sourcePath == "" {
		sourcePath = in.Path
	}
	if sourcePath == "" {
		sourcePath = "/"
	}

	parts := strings.Split(sourcePath, "/")
	decodedParts := make([]string, len(parts))
	rawParts := make([]string, len(parts))
	for i, p := range parts {
		if p == "" {
			decodedParts[i] = ""
			rawParts[i] = ""
			continue
		}
		decoded := decodePathSegmentPreserveEncodedSlash(p)
		decodedParts[i] = decoded
		rawParts[i] = url.PathEscape(decoded)
	}

	decodedPath := strings.Join(decodedParts, "/")
	rawPath := strings.Join(rawParts, "/")
	if decodedPath == "" || decodedPath[0] != '/' {
		decodedPath = "/" + decodedPath
	}
	if rawPath == "" || rawPath[0] != '/' {
		rawPath = "/" + rawPath
	}
	return decodedPath, rawPath
}

func init() {
	// Initialize S3 credentials from environment
	s3AccessKey = os.Getenv("S3_ACCESS_KEY")
	s3SecretKey = os.Getenv("S3_SECRET_KEY")
	s3Region = os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}
	// Check if debug logging is enabled
	s3DebugLog = os.Getenv("S3_DEBUG") == "true" || os.Getenv("S3_DEBUG") == "1"

	// Log credentials at startup (for debugging)
	if s3AccessKey != "" && s3SecretKey != "" {
		maskedSecret := s3SecretKey
		if len(s3SecretKey) > 8 {
			maskedSecret = s3SecretKey[:4] + "***" + s3SecretKey[len(s3SecretKey)-4:]
		} else {
			maskedSecret = "***"
		}
		obslib.LogInfo(context.Background(), "S3 credentials loaded",
			obslib.String("access_key", s3AccessKey),
			obslib.String("secret_key_masked", maskedSecret),
			obslib.String("region", s3Region),
		)
		s3Signer = v4.NewSigner()
		obslib.LogInfo(context.Background(), "S3 signer initialized")
	} else {
		obslib.LogWarn(context.Background(), "S3 credentials not configured; S3 requests will fail authentication",
			obslib.Bool("access_key_present", s3AccessKey != ""),
			obslib.Bool("secret_key_present", s3SecretKey != ""),
		)
	}
}

// corsAllowedMethods lists the HTTP methods the S3 proxy advertises in
// preflight responses. Kept narrow to S3 + range-read semantics used by
// DuckDB-WASM in the Lakekeeper catalog UI.
const corsAllowedMethods = "GET, POST, PUT, DELETE, HEAD, OPTIONS"

// corsAllowedHeaders enumerates request headers the browser may send. The
// SigV4 set covers AWS SDKs; Range/If-* and the literal "X-User-Agent" cover
// DuckDB-WASM range reads of Iceberg metadata and parquet files (the AWS
// signing variant is "X-Amz-User-Agent", but DuckDB-WASM sends the bare form).
// X-Host-Override is added by the Lakekeeper catalog UI when its configured S3
// URL differs from the storage endpoint; without it the browser blocks the
// preflighted GET of Iceberg snapshot/metadata objects.
const corsAllowedHeaders = "Authorization, Content-Type, Range, " +
	"If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, " +
	"X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, " +
	"X-Amz-User-Agent, X-User-Agent, X-Requested-With, X-Host-Override"

// corsExposedHeaders lists response headers JS is allowed to read. Range reads
// require Content-Range and Accept-Ranges; without them DuckDB-WASM cannot
// parse partial responses even when the bytes arrive.
const corsExposedHeaders = "ETag, Content-Length, Content-Range, Accept-Ranges, " +
	"Content-Type, Last-Modified, x-amz-request-id, x-amz-id-2"

// publicEndpointSuffix returns the configured public endpoint suffix (e.g.
// "agentstudio.dev.openeng.netapp.com") used to match `<sub>.<endpoint>`
// origins in CORS. An empty result disables suffix matching.
func publicEndpointSuffix() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv("PUBLIC_ENDPOINT")))
}

// isAllowedCORSOrigin reports whether the given Origin header value is from a
// trusted host for browser-driven cross-origin S3 access. Accepts:
//   - any subdomain of the configured PUBLIC_ENDPOINT
//     (e.g. https://catalog.agentstudio.dev.openeng.netapp.com:8443)
//   - any agentstudio.local host (local dev)
//
// The match is case-insensitive on host and ignores the port.
func isAllowedCORSOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())

	// Local dev: agentstudio.local and any subdomain thereof.
	if host == "agentstudio.local" || strings.HasSuffix(host, ".agentstudio.local") {
		return true
	}

	// Production/dev clusters: any subdomain of PUBLIC_ENDPOINT.
	if suffix := publicEndpointSuffix(); suffix != "" {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}

	return false
}

// corsHandler wraps an http.Handler to add CORS headers so the Lakekeeper
// catalog UI (DuckDB-WASM reading Iceberg metadata directly from `s3.<endpoint>`)
// and the AgentStudio console can issue cross-origin S3 requests.
//
// Notes on correctness:
//   - We only emit Access-Control-Allow-Origin (and Allow-Credentials) for a
//     trusted, concrete Origin. Pairing credentials with "*" is invalid per the
//     Fetch spec and browsers reject the response.
//   - For a present-but-untrusted Origin we emit no CORS grant. Returning "*"
//     would let any website read proxied S3 responses in the browser; because
//     this proxy signs unsigned inbound requests with the gateway's S3
//     credentials, a wildcard grant would enable cross-origin data exfiltration.
//     Non-browser and same-origin clients are unaffected (they don't enforce CORS).
func corsHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		originAllowed := isAllowedCORSOrigin(origin)

		setOrigin := func() {
			// The response varies by Origin regardless of the match outcome, so
			// advertise that. Add (not Set) preserves any existing Vary value
			// (e.g. Accept-Encoding) added upstream.
			w.Header().Add("Vary", "Origin")
			if originAllowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			// Otherwise emit no Access-Control-Allow-Origin: an untrusted browser
			// origin must be blocked rather than granted wildcard access.
		}

		if r.Method == http.MethodOptions {
			setOrigin()
			w.Header().Set("Access-Control-Allow-Methods", corsAllowedMethods)
			w.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
			w.Header().Set("Access-Control-Max-Age", "3600")
			w.WriteHeader(http.StatusNoContent)
			return
		}

		setOrigin()
		w.Header().Set("Access-Control-Expose-Headers", corsExposedHeaders)

		next.ServeHTTP(w, r)
	})
}

// BuildS3Proxy creates a reverse proxy for S3 requests
// Routes requests to s3gateway service, preserving S3 protocol headers
//
// IMPORTANT: This proxy does NOT read or buffer the request body for PUT/POST operations.
// - httputil.ReverseProxy streams the body directly without buffering
// - The Rewrite function only modifies headers and URL, never touches the body
// - SignHTTP is called with UNSIGNED-PAYLOAD for PUT/POST, which doesn't require reading the body
// - The request body is streamed directly from client -> apigateway -> s3gateway
func BuildS3Proxy() http.Handler {
	s3gatewayURL := os.Getenv("S3GATEWAY_URL")
	if s3gatewayURL == "" {
		s3gatewayURL = "http://s3gateway:7070"
	}

	target, err := url.Parse(s3gatewayURL)
	if err != nil {
		obslib.LogFatal(context.Background(), "Invalid S3GATEWAY_URL", obslib.Error(err))
	}

	proxy := &httputil.ReverseProxy{
		// Rewrite function modifies only headers and URL - NEVER touches the request body
		// The body is streamed directly by httputil.ReverseProxy without buffering
		Rewrite: func(proxyReq *httputil.ProxyRequest) {
			// Skip rewriting only for health check endpoints, not for S3 root listing
			if proxyReq.In.URL.Path == "/health" || proxyReq.In.URL.Path == "/ready" {
				return
			}

			inboundSigned := hasInboundSigV4(proxyReq.In)
			debugLog(proxyReq.In.Context(), "Inbound signing mode",
				obslib.Bool("presigned", inboundSigned), obslib.String("method", proxyReq.In.Method))

			proxyReq.Out.URL.Scheme = target.Scheme
			proxyReq.Out.Host = target.Host
			proxyReq.Out.URL.Host = target.Host
			proxyReq.Out.URL.RawQuery = proxyReq.In.URL.RawQuery
			if inboundSigned {
				// Preserve exact inbound host/path semantics so existing signatures remain valid.
				proxyReq.Out.URL.Path = proxyReq.In.URL.Path
				proxyReq.Out.URL.RawPath = proxyReq.In.URL.RawPath
				if proxyReq.Out.URL.RawPath == "" {
					proxyReq.Out.URL.RawPath = proxyReq.In.URL.EscapedPath()
				}
				proxyReq.Out.Host = proxyReq.In.Host
				proxyReq.Out.Header.Set("Host", proxyReq.In.Host)
				debugLog(proxyReq.In.Context(), "Passthrough signed request",
					obslib.String("path", proxyReq.Out.URL.Path),
					obslib.String("raw_path", proxyReq.Out.URL.RawPath),
					obslib.String("host", proxyReq.Out.Host),
				)
				return
			}

			decodedPath, rawPath := canonicalizeS3Path(proxyReq.In.URL)
			proxyReq.Out.URL.Path = decodedPath
			proxyReq.Out.URL.RawPath = rawPath
			proxyReq.Out.Host = target.Host
			proxyReq.Out.Header.Set("Host", target.Host)

			// Strip inbound AWS signing headers for unsigned/browser requests.
			for header := range proxyReq.Out.Header {
				h := strings.ToLower(header)
				if strings.HasPrefix(h, "x-amz-") || h == "authorization" || h == "x-amz-date" || h == "x-amz-security-token" || h == "x-amz-content-sha256" {
					proxyReq.Out.Header.Del(header)
				}
			}

			debugLog(proxyReq.In.Context(), "Outbound S3 request",
				obslib.String("url", proxyReq.Out.URL.String()),
				obslib.String("host", proxyReq.Out.Host),
				obslib.String("path", proxyReq.Out.URL.Path),
				obslib.String("raw_path", proxyReq.Out.URL.RawPath),
				obslib.String("scheme", proxyReq.Out.URL.Scheme),
			)

			// Gather credentials from env
			accessKey := os.Getenv("S3_ACCESS_KEY")
			secretKey := os.Getenv("S3_SECRET_KEY")

			// If missing credentials, warn once per request
			if accessKey == "" || secretKey == "" {
				obslib.LogWarn(proxyReq.In.Context(), "S3_ACCESS_KEY or S3_SECRET_KEY not set; request will be unsigned")
			} else {
				// Sign the request using AWS Signature V4 for S3
				// For streaming uploads (PUT/POST), use "UNSIGNED-PAYLOAD"
				// For GET/HEAD/DELETE with no body, use SHA256 of empty string
				var payloadHash string
				if proxyReq.Out.Method == "PUT" || proxyReq.Out.Method == "POST" {
					payloadHash = "UNSIGNED-PAYLOAD"
				} else {
					// For requests without a body, compute SHA256 of empty string
					// SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
					hash := sha256.Sum256([]byte{})
					payloadHash = hex.EncodeToString(hash[:])
				}

				// Set x-amz-content-sha256 header before signing
				proxyReq.Out.Header.Set("x-amz-content-sha256", payloadHash)

				// Create AWS credentials
				credentials := aws.Credentials{
					AccessKeyID:     accessKey,
					SecretAccessKey: secretKey,
				}

				// Sign the request
				err := s3Signer.SignHTTP(
					context.Background(),
					credentials,
					proxyReq.Out,
					payloadHash,
					"s3",
					s3Region,
					time.Now(),
				)
				if err != nil {
					obslib.LogError(proxyReq.In.Context(), "Failed to sign S3 request", obslib.Error(err))
				}
			}
			// print the headers of the out request
			// log.Printf("Out request headers: %v", proxyReq.Out.Header)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			obslib.LogError(r.Context(), "S3 proxy error",
				obslib.String("path", r.URL.Path), obslib.Error(err))
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>BadGateway</Code>
  <Message>Failed to connect to S3 gateway</Message>
  <RequestId></RequestId>
</Error>`))
		},
	}

	// Wrap proxy with CORS handler to allow cross-origin requests
	return corsHandler(proxy)
}

// IsS3Subdomain checks if the request is for the S3 public host.
//
// The chart now exposes S3 on a single bare host: s3.{endpoint} with
// path-style addressing (https://s3.{endpoint}/<bucket>/<key>). Virtual-hosted
// addressing (<bucket>.s3.{endpoint}) and regional subdomain forms
// (us-east-1.s3.{endpoint}) are no longer routed because their hostnames are
// two labels deep and a single-label wildcard DNS does not cover them.
// All S3 clients must therefore use path-style addressing — see
// global.s3PathStyle in deployments/helm/nemo/values.yaml.
//
// We still tolerate ".s3." anywhere in the hostname for backward
// compatibility with internal callers that may have been hardcoded to the
// virtual-hosted form, but external traffic addressed that way will fail at
// DNS before reaching the gateway anyway.
func IsS3Subdomain(hostname string) bool {
	if strings.HasPrefix(hostname, "s3.") {
		return true
	}
	// Backward-compat tolerance for internal callers; new clients should not
	// rely on this branch.
	if strings.Contains(hostname, ".s3.") {
		return true
	}
	return false
}

// IsS3Request checks if a request is an S3 request by examining query parameters, headers, and path patterns
// This handles cases where requests come directly to the gateway (not via subdomain)
// Used for requests from lakekeeper and other internal services that make direct S3 calls
func IsS3Request(r *http.Request) bool {
	// Known gateway paths that should NOT be treated as S3
	knownGatewayPaths := []string{
		"/api-docs",
		"/config",
		"/console",
		"/health",
		"/ready",
		"/",
	}

	path := r.URL.Path
	// Skip if it's a known gateway path
	for _, knownPath := range knownGatewayPaths {
		if path == knownPath || strings.HasPrefix(path, knownPath+"/") {
			return false
		}
	}

	// Check for S3-specific query parameters (AWS SDK uses x-id for operation identification)
	if xid := r.URL.Query().Get("x-id"); xid != "" {
		s3Operations := []string{"PutObject", "GetObject", "DeleteObject", "HeadObject", "ListObjects", "ListObjectsV2", "CreateBucket", "DeleteBucket", "HeadBucket", "PutObjectTagging", "GetObjectTagging"}
		for _, op := range s3Operations {
			if xid == op {
				return true
			}
		}
	}

	// Check for S3-specific query parameters (common in S3 API)
	s3QueryParams := []string{"list-type", "prefix", "delimiter", "marker", "max-keys", "encoding-type", "continuation-token", "start-after", "part-number", "uploadId", "response-cache-control", "response-content-type", "response-content-disposition", "response-content-encoding", "response-content-language", "response-expires"}
	for _, param := range s3QueryParams {
		if r.URL.Query().Get(param) != "" {
			return true
		}
	}

	// Check for S3-specific headers
	if r.Header.Get("X-Amz-Content-Sha256") != "" ||
		r.Header.Get("X-Amz-Date") != "" ||
		strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256") ||
		strings.HasPrefix(r.Header.Get("Authorization"), "AWS ") {
		return true
	}

	// Check HTTP methods commonly used for S3 operations
	// S3 uses PUT (upload), GET (download), HEAD (metadata), DELETE (remove), POST (multipart)
	s3Methods := []string{"PUT", "GET", "HEAD", "DELETE", "POST"}
	isS3Method := false
	for _, method := range s3Methods {
		if r.Method == method {
			isS3Method = true
			break
		}
	}

	// Check if path looks like an S3 bucket/object path pattern
	// S3 path-style: /bucket-name/object-key or /bucket-name
	// Remove leading slash and split
	pathParts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(pathParts) >= 1 && pathParts[0] != "" {
		firstPart := pathParts[0]

		// Exclude known non-S3 prefixes
		excludedPrefixes := []string{"api-", "config", "console", "ws-", "workspace-"}
		isExcluded := false
		for _, prefix := range excludedPrefixes {
			if strings.HasPrefix(firstPart, prefix) {
				isExcluded = true
				break
			}
		}

		// If it's an S3 HTTP method and path doesn't match excluded patterns, it's likely S3
		// This handles lakekeeper requests like PUT /bucket-name/object-key
		if isS3Method && !isExcluded {
			// Additional check: bucket names typically don't contain certain characters
			// and are not empty
			if len(firstPart) > 0 && len(firstPart) <= 63 { // S3 bucket name length limit
				// If we have a path like /bucket or /bucket/object with S3 method, treat as S3
				// This catches lakekeeper PUT requests to /bucket/object paths
				return true
			}
		}
	}

	return false
}
