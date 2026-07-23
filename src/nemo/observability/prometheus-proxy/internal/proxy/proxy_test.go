package proxy

import (
	"testing"
)

// rewriteQueryTestCase represents a single PromQL rewrite test.
type rewriteQueryTestCase struct {
	name            string
	query           string
	allowedProjects []string
	wantOK          bool
	wantContains    string // substring that must appear in the rewritten query
	wantContains2   string // optional second substring that must also appear
	wantNotContains string // substring that must NOT appear in the rewritten query
}

func TestRewriteQuery(t *testing.T) {
	aliceProjects := []string{"proj-alice", "proj-shared"}
	bobProjects := []string{"proj-bob"}
	noProjects := []string{}

	tests := []rewriteQueryTestCase{
		// -------------------------------------------------------------------------
		// Case 1: dashboard queries that already contain project_id=~"$project"
		// These are the most common queries from AgentStudio dashboards.
		// -------------------------------------------------------------------------
		{
			name:            "replace $project variable in dashboard query",
			query:           `http_server_request_count_total{project_id=~"$project",service="svc"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
			wantNotContains: `"$project"`,
		},
		{
			name:            "replace explicit project_id value in injection attempt",
			query:           `http_server_request_count_total{project_id=~".*",service="svc"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
			wantNotContains: `".*"`,
		},
		{
			name: "replace project_id in nested rate() query",
			query: `rate(http_server_request_count_total{exported_service_name=~"svc",` +
				`project_id=~"$project",url_path!~"health"}[5m])`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
		},
		{
			name: "replace project_id in histogram query (attacker tries to see all projects)",
			query: `histogram_quantile(0.99, sum by (le) (rate(` +
				`http_server_request_duration_seconds_bucket{project_id="proj-bob"}[5m])))`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
			wantNotContains: `"proj-bob"`,
		},
		{
			name:            "exact-match injection replaced",
			query:           `metric{project_id="proj-bob"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
		},
		{
			name:            "negation injection replaced",
			query:           `metric{project_id!="proj-alice"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
		},

		// -------------------------------------------------------------------------
		// Case 2: query has {labels} without project_id — inject it
		// -------------------------------------------------------------------------
		{
			name:            "inject into selector with existing labels",
			query:           `metric{service="web",env="prod"}`,
			allowedProjects: bobProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-bob)$"`,
		},
		{
			name:            "inject into empty selector",
			query:           `metric{}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
		},
		{
			name:            "inject into multiple selectors in one query",
			query:           `metric_a{env="a"} + metric_b{env="b"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice|proj-shared)$"`,
		},

		// -------------------------------------------------------------------------
		// Case 3: bare metric name — append selector
		// -------------------------------------------------------------------------
		{
			name:            "bare metric name gets selector appended",
			query:           "up",
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `up{project_id=~"^(proj-alice|proj-shared)$"}`,
		},

		// -------------------------------------------------------------------------
		// No-access cases: empty project list → block
		// -------------------------------------------------------------------------
		{
			name:            "empty project list blocks any query",
			query:           `metric{project_id=~"$project"}`,
			allowedProjects: noProjects,
			wantOK:          false,
		},
		{
			name:            "empty project list blocks selector-less query",
			query:           `metric{}`,
			allowedProjects: noProjects,
			wantOK:          false,
		},

		// -------------------------------------------------------------------------
		// Pure scalar expressions — safe to pass through
		// -------------------------------------------------------------------------
		{
			name:            "pure scalar passes through",
			query:           "1+1",
			allowedProjects: aliceProjects,
			wantOK:          true,
		},

		// -------------------------------------------------------------------------
		// Unsupported complex forms — blocked
		// -------------------------------------------------------------------------
		{
			name:            "complex expression without selectors blocked",
			query:           "some_metric offset 5m",
			allowedProjects: aliceProjects,
			wantOK:          false,
		},

		// -------------------------------------------------------------------------
		// Regex special characters in project IDs must be escaped
		// -------------------------------------------------------------------------
		{
			name:            "project ID with regex special chars is safely escaped",
			query:           `metric{project_id=~"$project"}`,
			allowedProjects: []string{"proj.alpha+beta", "proj[test]"},
			wantOK:          true,
			wantContains:    `proj\.alpha\+beta`,
			wantNotContains: `"$project"`,
		},

		// -------------------------------------------------------------------------
		// Intersection: user's dropdown selection must be respected (not overridden
		// with the full allowed list) while the security boundary is still enforced.
		// -------------------------------------------------------------------------
		{
			name:            "single project selection is respected",
			query:           `metric{project_id=~"proj-alice"}`,
			allowedProjects: aliceProjects, // [proj-alice, proj-shared]
			wantOK:          true,
			wantContains:    `project_id=~"^(proj-alice)$"`,
			wantNotContains: `proj-shared`,
		},
		{
			name:            "multi-project selection respected when subset of allowed",
			query:           `metric{project_id=~"proj-alice|proj-shared"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `proj-alice`,
			wantNotContains: `"$project"`,
		},
		{
			name:            "anchored all-projects expansion respected",
			query:           `metric{project_id=~"^(proj-alice|proj-shared)$"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `proj-alice`,
			wantContains2:   `proj-shared`,
		},
		{
			name:            "grouped multi-selection respected",
			query:           `metric{project_id=~"(proj-alice|proj-shared)"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `proj-alice`,
		},
		{
			name:            "requested project not in allowed list is silently dropped",
			query:           `metric{project_id=~"proj-bob"}`,
			allowedProjects: aliceProjects, // proj-bob not in alice's list
			wantOK:          true,
			// Falls back to full allowed list since intersection is empty.
			wantContains:    `proj-alice`,
			wantNotContains: `proj-bob`,
		},
		{
			name:            "wildcard pattern falls back to full allowed list",
			query:           `metric{project_id=~".*"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `proj-alice`,
			wantContains2:   `proj-shared`,
		},
		{
			name:            "mixed valid and invalid projects: keeps only valid",
			query:           `metric{project_id=~"proj-alice|proj-evil"}`,
			allowedProjects: aliceProjects,
			wantOK:          true,
			wantContains:    `proj-alice`,
			wantNotContains: `proj-evil`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := rewriteQuery(tc.query, tc.allowedProjects)
			if ok != tc.wantOK {
				t.Errorf("rewriteQuery(%q, %v) ok=%v, want %v\n  got: %q",
					tc.query, tc.allowedProjects, ok, tc.wantOK, got)
				return
			}
			if !ok {
				return // blocked as expected, nothing else to check
			}
			if tc.wantContains != "" && !containsStr(got, tc.wantContains) {
				t.Errorf("rewriteQuery result missing expected substring\n  want: %q\n  got:  %q",
					tc.wantContains, got)
			}
			if tc.wantContains2 != "" && !containsStr(got, tc.wantContains2) {
				t.Errorf("rewriteQuery result missing second expected substring\n  want: %q\n  got:  %q",
					tc.wantContains2, got)
			}
			if tc.wantNotContains != "" && containsStr(got, tc.wantNotContains) {
				t.Errorf("rewriteQuery result contains forbidden substring\n  must not contain: %q\n  got: %q",
					tc.wantNotContains, got)
			}
		})
	}
}

// TestLabelNameFromPath verifies the label-name extractor handles various URL shapes.
func TestLabelNameFromPath(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"/api/v1/label/project_id/values", "project_id"},
		{"/api/v1/label/exported_service_name/values", "exported_service_name"},
		{"/api/v1/label/__name__/values", "__name__"},
		{"/api/v1/label/", ""},
		{"/api/v1/labels", ""},
	}
	for _, c := range cases {
		got := labelNameFromPath(c.path)
		if got != c.want {
			t.Errorf("labelNameFromPath(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}
