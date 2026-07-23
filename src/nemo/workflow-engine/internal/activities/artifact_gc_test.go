package activities

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

// initBareRepo creates a bare repo at projects/{proj}/artifacts/{store}
// under tmp, primes it with one commit on main, and writes a session
// branch pointing at that commit with a backdated commit timestamp.
func initBareRepo(t *testing.T, tmpRoot, proj, store string, backdate time.Duration) string {
	t.Helper()
	repo := filepath.Join(tmpRoot, "projects", proj, "artifacts", store)
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}

	run := func(env []string, args ...string) {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = append(os.Environ(), env...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args[1:], err, out)
		}
	}

	run(nil, "git", "init", "--quiet", "--bare", "--initial-branch=main", repo)

	// Seed an initial commit. With a bare repo we can use a fast-import
	// commit via a temp worktree:
	worktree := filepath.Join(tmpRoot, "wt-"+proj+"-"+store)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("mkdir worktree: %v", err)
	}
	defer os.RemoveAll(worktree)

	commitEnv := []string{
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	}
	when := time.Now().Add(-backdate)
	dateStr := fmt.Sprintf("%d -0000", when.Unix())
	dateEnv := []string{
		"GIT_AUTHOR_DATE=" + dateStr,
		"GIT_COMMITTER_DATE=" + dateStr,
	}

	// Add file to worktree and commit, pushing into the bare repo.
	run(nil, "git", "clone", "--quiet", repo, worktree)
	if err := os.WriteFile(filepath.Join(worktree, "seed.txt"), []byte("seed"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}
	runWt := func(extraEnv []string, args ...string) {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = worktree
		cmd.Env = append(os.Environ(), append(commitEnv, extraEnv...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("[wt] git %v: %v\n%s", args[1:], err, out)
		}
	}
	runWt(nil, "git", "add", "seed.txt")
	runWt(dateEnv, "git", "commit", "--quiet", "-m", "seed")

	// Create the session branch at the same commit but with backdated
	// timestamp baked into a second commit (so its tip time is "old").
	if err := os.WriteFile(filepath.Join(worktree, "session.txt"), []byte("s"), 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}
	runWt(nil, "git", "checkout", "--quiet", "-b", "sessions/sess-old")
	runWt(nil, "git", "add", "session.txt")
	runWt(dateEnv, "git", "commit", "--quiet", "-m", "session work")
	runWt(nil, "git", "push", "--quiet", "origin", "sessions/sess-old")

	return repo
}

func listBranchSet(t *testing.T, gitDir string) map[string]bool {
	t.Helper()
	out, err := exec.Command("git", "--git-dir="+gitDir, "for-each-ref",
		"--format=%(refname)", "refs/heads/").Output()
	if err != nil {
		t.Fatalf("for-each-ref: %v", err)
	}
	set := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			set[line] = true
		}
	}
	return set
}

func TestRunArtifactGCActivity_ArchivesStaleSessionBranch(t *testing.T) {
	tmp := t.TempDir()
	repo := initBareRepo(t, tmp, "proj1", "asabcdefgh", 48*time.Hour)

	res, err := RunArtifactGCActivity(context.Background(), types.ArtifactGCInput{
		StoreRoot:   tmp,
		MaxAgeHours: 24,
	})
	if err != nil {
		t.Fatalf("activity returned error: %v", err)
	}
	if res.ReposScanned != 1 {
		t.Fatalf("expected ReposScanned=1, got %d", res.ReposScanned)
	}
	if res.BranchesArchived != 1 {
		t.Fatalf("expected BranchesArchived=1, got %d (errors=%v)", res.BranchesArchived, res.Errors)
	}

	branches := listBranchSet(t, repo)
	if branches["refs/heads/sessions/sess-old"] {
		t.Fatalf("stale session branch should have been removed: %v", branches)
	}
	var sawArchive bool
	for name := range branches {
		if strings.HasPrefix(name, "refs/heads/sessions-archive/sess-old-") {
			sawArchive = true
			break
		}
	}
	if !sawArchive {
		t.Fatalf("archive branch missing: %v", branches)
	}
}

func TestRunArtifactGCActivity_KeepsFreshSessionBranch(t *testing.T) {
	tmp := t.TempDir()
	initBareRepo(t, tmp, "proj1", "asabcdefgh", 1*time.Hour)

	res, err := RunArtifactGCActivity(context.Background(), types.ArtifactGCInput{
		StoreRoot:   tmp,
		MaxAgeHours: 24,
	})
	if err != nil {
		t.Fatalf("activity returned error: %v", err)
	}
	if res.BranchesArchived != 0 {
		t.Fatalf("expected BranchesArchived=0, got %d", res.BranchesArchived)
	}
	if res.BranchesKept != 1 {
		t.Fatalf("expected BranchesKept=1, got %d", res.BranchesKept)
	}
}

func TestRunArtifactGCActivity_SkipsNonRepoDirs(t *testing.T) {
	tmp := t.TempDir()
	// _blobs dir under projects/proj1/artifacts/ should be ignored.
	if err := os.MkdirAll(filepath.Join(tmp, "projects", "proj1", "artifacts", "_blobs", "sha256"), 0o755); err != nil {
		t.Fatalf("mkdir _blobs: %v", err)
	}
	// Empty repo-shaped dir (no HEAD) should be skipped.
	if err := os.MkdirAll(filepath.Join(tmp, "projects", "proj1", "artifacts", "garbage"), 0o755); err != nil {
		t.Fatalf("mkdir garbage: %v", err)
	}
	res, err := RunArtifactGCActivity(context.Background(), types.ArtifactGCInput{StoreRoot: tmp})
	if err != nil {
		t.Fatalf("activity returned error: %v", err)
	}
	if res.ReposScanned != 0 {
		t.Fatalf("expected no repos scanned, got %d", res.ReposScanned)
	}
}

func TestRunArtifactGCActivity_NoRootIsOK(t *testing.T) {
	tmp := t.TempDir()
	res, err := RunArtifactGCActivity(context.Background(), types.ArtifactGCInput{
		StoreRoot: filepath.Join(tmp, "does-not-exist"),
	})
	if err != nil {
		t.Fatalf("activity should tolerate missing root: %v", err)
	}
	if res.ReposScanned != 0 {
		t.Fatalf("expected 0 repos scanned, got %d", res.ReposScanned)
	}
}
