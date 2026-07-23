package secretsclient

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// renameHandler is called with the absolute path of a file involved in a
// rename/create event.
type renameHandler func(filePath string)

// directoryWatcher places a non-recursive fsnotify watch on the root directory
// and every real (non-symlink) subdirectory, mirroring the TypeScript and
// Python DirectoryWatcher implementations.
//
// Directories whose names start with ".." (CSI driver versioned data
// directories such as "..data_v2") are deliberately skipped to avoid inotify
// handle exhaustion on long-lived clusters. The "..data" symlink-swap
// rotation is detected at the root level instead.
type directoryWatcher struct {
	root     string
	watcher  *fsnotify.Watcher
	onRename renameHandler
	onError  func(err error)
	watched  map[string]struct{}
	mu       sync.Mutex
	closed   bool
}

func newDirectoryWatcher(
	root string,
	onRename renameHandler,
	onError func(err error),
) (*directoryWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	dw := &directoryWatcher{
		root:     root,
		watcher:  w,
		onRename: onRename,
		onError:  onError,
		watched:  make(map[string]struct{}),
	}
	if err := dw.watchDir(root); err != nil {
		_ = w.Close()
		return nil, err
	}
	go dw.loop()
	return dw, nil
}

func (dw *directoryWatcher) watchDir(dir string) error {
	dw.mu.Lock()
	if _, ok := dw.watched[dir]; ok {
		dw.mu.Unlock()
		return nil
	}
	dw.watched[dir] = struct{}{}
	dw.mu.Unlock()

	if err := dw.watcher.Add(dir); err != nil {
		return err
	}

	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "..") {
			continue
		}
		// Use Lstat (not entry.Info which follows symlinks) so symlinked
		// directories are detected and excluded correctly.
		info, err := os.Lstat(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		// Only recurse into real (non-symlink) directories.
		if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			_ = dw.watchDir(filepath.Join(dir, entry.Name()))
		}
	}
	return nil
}

func (dw *directoryWatcher) loop() {
	for {
		select {
		case event, ok := <-dw.watcher.Events:
			if !ok {
				return
			}
			dw.mu.Lock()
			closed := dw.closed
			dw.mu.Unlock()
			if closed {
				return
			}
			// Handle RENAME (source path) and CREATE (destination path).
			// Together these cover the full atomic-rename event pair on Linux
			// (inotify IN_MOVED_FROM + IN_MOVED_TO).
			if event.Has(fsnotify.Rename) || event.Has(fsnotify.Create) {
				// If a real non-".." subdirectory just appeared, start watching it.
				if info, err := os.Lstat(event.Name); err == nil &&
					info.IsDir() && info.Mode()&os.ModeSymlink == 0 &&
					!strings.HasPrefix(filepath.Base(event.Name), "..") {
					_ = dw.watchDir(event.Name)
				}
				dw.onRename(event.Name)
			}

		case err, ok := <-dw.watcher.Errors:
			if !ok {
				return
			}
			dw.mu.Lock()
			closed := dw.closed
			dw.mu.Unlock()
			if !closed && dw.onError != nil {
				dw.onError(err)
			}
		}
	}
}

func (dw *directoryWatcher) close() {
	dw.mu.Lock()
	dw.closed = true
	dw.mu.Unlock()
	_ = dw.watcher.Close()
}

// debouncedHandler accumulates every unique file path seen within delay and
// then calls fn once for each. Unlike last-arg-wins debounce, this guarantees
// that both the source and destination of an atomic rename are processed
// regardless of delivery order.
type debouncedHandler struct {
	fn      func(string)
	delay   time.Duration
	mu      sync.Mutex
	pending map[string]struct{}
	timer   *time.Timer
}

func newDebouncedHandler(fn func(string), delayMs int) *debouncedHandler {
	return &debouncedHandler{
		fn:      fn,
		delay:   time.Duration(delayMs) * time.Millisecond,
		pending: make(map[string]struct{}),
	}
}

func (d *debouncedHandler) call(filePath string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.pending[filePath] = struct{}{}
	if d.timer != nil {
		d.timer.Stop()
	}
	d.timer = time.AfterFunc(d.delay, d.flush)
}

func (d *debouncedHandler) flush() {
	d.mu.Lock()
	paths := make([]string, 0, len(d.pending))
	for p := range d.pending {
		paths = append(paths, p)
	}
	d.pending = make(map[string]struct{})
	d.timer = nil
	d.mu.Unlock()
	for _, p := range paths {
		d.fn(p)
	}
}

func (d *debouncedHandler) cancel() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
	d.pending = make(map[string]struct{})
}
