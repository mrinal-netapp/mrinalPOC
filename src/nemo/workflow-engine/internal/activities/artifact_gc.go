package activities

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

// RunArtifactGCActivity sweeps every artifact-store bare repo under
// `<root>/projects/{projectId}/artifacts/{storeId}/`, archiving session
// branches whose tip commit is older than the configured threshold.
//
// The activity runs `git` as a subprocess on the local filesystem of
// the worker pod, which must have the shared NFS PVC mounted. This is
// the same arrangement KB workers use today.
//
// Behaviour:
//   - For each `refs/heads/sessions/{sid}`, read tip commit time via
//     `git log -1 --format=%ct`.
//   - If tip > MaxAgeHours old, rename to
//     `refs/heads/sessions-archive/{sid}-{epochSec}` using two
//     `git update-ref` operations (no checkout needed; bare repos).
//   - Optionally run `git gc --auto` per repo.
//
// Errors on a single repo do not abort the sweep — they're collected
// into the result.
func RunArtifactGCActivity(ctx context.Context, input types.ArtifactGCInput) (types.ArtifactGCResult, error) {
	root := input.StoreRoot
	if root == "" {
		root = os.Getenv("NEMO_DEFAULT_STORE_ROOT")
	}
	if root == "" {
		root = "/mnt/pvcs/default-nemo"
	}
	maxAge := input.MaxAgeHours
	if maxAge <= 0 {
		maxAge = 24
	}
	cutoff := time.Now().Add(-time.Duration(maxAge) * time.Hour)

	result := types.ArtifactGCResult{}
	projectsDir := filepath.Join(root, "projects")
	projects, err := listChildDirs(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			// Shared NFS not yet populated; nothing to do.
			return result, nil
		}
		return result, fmt.Errorf("list projects: %w", err)
	}

	wanted := map[string]bool{}
	for _, p := range input.ProjectIDs {
		wanted[p] = true
	}

	for _, project := range projects {
		if len(wanted) > 0 && !wanted[project] {
			continue
		}
		artifactsDir := filepath.Join(projectsDir, project, "artifacts")
		stores, err := listChildDirs(artifactsDir)
		if err != nil {
			if !os.IsNotExist(err) {
				result.Errors = append(result.Errors,
					fmt.Sprintf("list artifacts %s: %v", project, err))
			}
			continue
		}
		for _, storeID := range stores {
			// Skip the per-project blob sidecar and any other reserved dirs.
			if strings.HasPrefix(storeID, "_") {
				continue
			}
			repoDir := filepath.Join(artifactsDir, storeID)
			if !looksLikeBareRepo(repoDir) {
				continue
			}
			result.ReposScanned++
			// Heartbeat between repos so Temporal's HeartbeatTimeout (2m
			// in the workflow) doesn't fire when scanning a large fleet
			// of stores. Safe-wrap because the SDK's RecordHeartbeat
			// panics when called outside a real activity context (e.g.
			// from `go test` calling this function directly with
			// context.Background()); production traffic always has a
			// proper activity context.
			safeHeartbeat(ctx, map[string]int{
				"repos_scanned":     result.ReposScanned,
				"repos_gced":        result.ReposGCed,
				"branches_kept":     result.BranchesKept,
				"branches_archived": result.BranchesArchived,
				"errors":            len(result.Errors),
			})
			if err := gcOneRepo(ctx, repoDir, cutoff, input.RunGitGC, &result); err != nil {
				result.Errors = append(result.Errors,
					fmt.Sprintf("%s/%s: %v", project, storeID, err))
			}
		}
	}
	return result, nil
}

func gcOneRepo(
	ctx context.Context,
	repoDir string,
	cutoff time.Time,
	runGC bool,
	out *types.ArtifactGCResult,
) error {
	// Enumerate session branches: `git for-each-ref --format='%(refname)' refs/heads/sessions`
	cmd := exec.CommandContext(ctx, "git",
		"--git-dir="+repoDir,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads/sessions",
	)
	listOut, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("for-each-ref: %w", err)
	}
	refs := splitNonEmpty(string(listOut))

	for _, ref := range refs {
		// Read tip time.
		ts, err := readCommitTimestamp(ctx, repoDir, ref)
		if err != nil {
			out.Errors = append(out.Errors,
				fmt.Sprintf("%s: read tip: %v", ref, err))
			continue
		}
		if ts.After(cutoff) {
			out.BranchesKept++
			continue
		}
		// Archive: refs/heads/sessions/{sid}  ->  refs/heads/sessions-archive/{sid}-{epoch}
		sid := strings.TrimPrefix(ref, "refs/heads/sessions/")
		archiveRef := fmt.Sprintf(
			"refs/heads/sessions-archive/%s-%d",
			sid, ts.Unix(),
		)
		oid, err := resolveRefOid(ctx, repoDir, ref)
		if err != nil {
			out.Errors = append(out.Errors,
				fmt.Sprintf("%s: resolve oid: %v", ref, err))
			continue
		}
		if err := updateRef(ctx, repoDir, archiveRef, oid, ""); err != nil {
			out.Errors = append(out.Errors,
				fmt.Sprintf("%s: create archive ref: %v", ref, err))
			continue
		}
		if err := deleteRef(ctx, repoDir, ref, oid); err != nil {
			// Best effort rollback: only delete the archive ref we just
			// created, and only if it still points at the oid we just
			// wrote. Without the CAS, a concurrent process could have
			// updated the archive ref before us and we'd silently delete
			// their work.
			_ = deleteRef(ctx, repoDir, archiveRef, oid)
			out.Errors = append(out.Errors,
				fmt.Sprintf("%s: delete original: %v", ref, err))
			continue
		}
		out.BranchesArchived++
	}

	if runGC {
		cmd := exec.CommandContext(ctx, "git", "--git-dir="+repoDir, "gc", "--auto", "--quiet")
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("git gc: %w", err)
		}
		out.ReposGCed++
	}
	return nil
}

func readCommitTimestamp(ctx context.Context, gitDir, ref string) (time.Time, error) {
	cmd := exec.CommandContext(ctx, "git",
		"--git-dir="+gitDir,
		"log", "-1",
		"--format=%ct",
		ref,
	)
	out, err := cmd.Output()
	if err != nil {
		return time.Time{}, err
	}
	secs, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(secs, 0), nil
}

func resolveRefOid(ctx context.Context, gitDir, ref string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "--git-dir="+gitDir, "rev-parse", ref)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func updateRef(ctx context.Context, gitDir, ref, newOid, oldOid string) error {
	args := []string{"--git-dir=" + gitDir, "update-ref", ref, newOid}
	if oldOid != "" {
		args = append(args, oldOid)
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	return cmd.Run()
}

func deleteRef(ctx context.Context, gitDir, ref, expectedOid string) error {
	args := []string{"--git-dir=" + gitDir, "update-ref", "-d", ref}
	if expectedOid != "" {
		args = append(args, expectedOid)
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	return cmd.Run()
}

func listChildDirs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func looksLikeBareRepo(path string) bool {
	if _, err := os.Stat(filepath.Join(path, "HEAD")); err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(path, "objects")); err != nil {
		return false
	}
	return true
}

// safeHeartbeat wraps activity.RecordHeartbeat in a defer/recover so
// callers from outside a Temporal activity context (notably unit
// tests calling the activity function directly) don't panic. In
// production this is a no-op around a normal RecordHeartbeat call.
func safeHeartbeat(ctx context.Context, details ...interface{}) {
	defer func() { _ = recover() }()
	activity.RecordHeartbeat(ctx, details...)
}

func splitNonEmpty(s string) []string {
	parts := strings.Split(strings.TrimSpace(s), "\n")
	out := []string{}
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
