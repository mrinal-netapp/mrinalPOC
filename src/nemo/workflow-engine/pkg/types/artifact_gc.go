package types

// ArtifactGCInput parameterises the daily GC sweep over artifact-store
// bare repos on the shared NFS volume.
type ArtifactGCInput struct {
	// Filter to specific project IDs. Empty = all projects.
	ProjectIDs []string `json:"projectIds,omitempty"`
	// Session branches whose tip commit is older than MaxAgeHours are
	// renamed to refs/heads/sessions-archive/{name}-{ts}. Defaults to 24.
	MaxAgeHours int `json:"maxAgeHours,omitempty"`
	// When true, also run `git gc --auto` on each scanned repo (cheap;
	// only repacks when git thinks it's worth it).
	RunGitGC bool `json:"runGitGC,omitempty"`
	// Override the on-disk root. Defaults to env NEMO_DEFAULT_STORE_ROOT
	// or /mnt/pvcs/default-nemo.
	StoreRoot string `json:"storeRoot,omitempty"`
}

// ArtifactGCResult summarises what one sweep did.
type ArtifactGCResult struct {
	ReposScanned     int      `json:"reposScanned"`
	BranchesArchived int      `json:"branchesArchived"`
	BranchesKept     int      `json:"branchesKept"`
	ReposGCed        int      `json:"reposGCed"`
	Errors           []string `json:"errors,omitempty"`
}
