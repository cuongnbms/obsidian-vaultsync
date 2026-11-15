// SPDX-License-Identifier: MIT

// Package blob is content-addressed storage: blobs/<sha256[0:2]>/<sha256>.
//
// It buys three things for free: deduplication, idempotent uploads (a retry writes
// the same path) and history — an old revision stays on disk for as long as a row
// in revisions still points at it.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var ErrNotFound = errors.New("blob not found")

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidHash rejects attempts to pass a path where a hash is expected.
func ValidHash(h string) bool { return hashRe.MatchString(h) }

type Store struct {
	root string
	// Uploads hold it shared between storing content and committing the row that
	// points at it; a sweep holds it alone. See Hold.
	mu sync.RWMutex
}

func Open(root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0o700); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

func (s *Store) path(hash string) string {
	return filepath.Join(s.root, hash[:2], hash)
}

// Staged is an upload written to the staging directory and hashed, not yet
// stored under its hash.
type Staged struct {
	Hash  string
	Size  int64
	store *Store
	tmp   *os.File
	done  bool
}

// Stage takes a stream and writes it to a temporary file, hashing it as it goes.
// Nothing is visible under the hash until Commit, so an interrupted upload cannot
// leave a truncated blob behind. Discard must be called either way.
func (s *Store) Stage(r io.Reader, limit int64) (*Staged, error) {
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "up-*")
	if err != nil {
		return nil, err
	}
	st := &Staged{store: s, tmp: tmp}
	h := sha256.New()
	src := io.Reader(r)
	if limit > 0 {
		src = io.LimitReader(r, limit+1)
	}
	size, err := io.Copy(io.MultiWriter(tmp, h), src)
	if err != nil {
		st.Discard()
		return nil, err
	}
	if limit > 0 && size > limit {
		st.Discard()
		return nil, fmt.Errorf("payload exceeds limit of %d bytes", limit)
	}
	st.Hash, st.Size = hex.EncodeToString(h.Sum(nil)), size
	return st, nil
}

// Commit stores the staged content under its hash. It is called while holding
// the store (Hold), so that no sweep runs between it and the row that will point
// at the content.
func (st *Staged) Commit() error {
	dst := st.store.path(st.Hash)
	// Already stored: deduplication. The existing blob may be old and about to
	// lose its last reference, so reusing it restarts its grace period; a sweep in
	// another process (the gc command) would otherwise take it before this
	// upload's row lands. Gone between the check and the touch means storing it.
	now := time.Now()
	if err := os.Chtimes(dst, now, now); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	dir := filepath.Dir(dst)
	_, statErr := os.Stat(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if errors.Is(statErr, os.ErrNotExist) {
		// A new shard directory has to survive a power cut too.
		if err := syncDir(st.store.root); err != nil {
			return err
		}
	}
	// Synced only once it is certain to be kept: a duplicate costs no fsync.
	if err := st.tmp.Sync(); err != nil {
		return err
	}
	if err := st.tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(st.tmp.Name(), dst); err != nil {
		return err
	}
	st.done = true
	// The rename lives in the directory. The metadata commit that follows is
	// synced, so the directory has to be as well, or a power cut can keep the row
	// and lose the content.
	return syncDir(dir)
}

// Discard removes the staged file unless Commit took it. Safe to call twice.
func (st *Staged) Discard() {
	if st == nil || st.tmp == nil {
		return
	}
	st.tmp.Close()
	if !st.done {
		os.Remove(st.tmp.Name())
	}
	st.tmp = nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Hold keeps sweeps off this store until release is called. An upload holds it
// from storing its content to committing the row that points at it, and no
// longer: the body is read before, so a slow upload stalls neither a sweep nor,
// through a sweep waiting for it, the other uploads.
func (s *Store) Hold() (release func()) {
	s.mu.RLock()
	return s.mu.RUnlock
}

// Put stages and stores content in one go, for callers that do not commit a row
// of their own right after (import, tests).
func (s *Store) Put(r io.Reader, limit int64) (hash string, size int64, err error) {
	st, err := s.Stage(r, limit)
	if err != nil {
		return "", 0, err
	}
	defer st.Discard()
	release := s.Hold()
	defer release()
	if err := st.Commit(); err != nil {
		return "", 0, err
	}
	return st.Hash, st.Size, nil
}

// Open returns content by hash. *os.File is needed as a ReadSeeker for Range requests.
func (s *Store) Open(hash string) (*os.File, error) {
	if !ValidHash(hash) {
		return nil, ErrNotFound
	}
	f, err := os.Open(s.path(hash))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

func (s *Store) Has(hash string) bool {
	if !ValidHash(hash) {
		return false
	}
	_, err := os.Stat(s.path(hash))
	return err == nil
}

// SweepResult reports what a sweep found or removed.
type SweepResult struct {
	Removed int64
	Bytes   int64
}

// Sweep deletes blobs nothing points at any more.
//
// The set of live hashes has to come from the metadata in one piece: content is
// shared between paths and revisions, so a blob is only garbage when the entire
// vault has stopped referring to it. Anything the store did not name is removed,
// which also collects the blobs left behind by uploads that ended in a conflict.
//
// live is called with uploads held off, so the set it returns cannot miss a row
// this process commits during the sweep. A blob modified less than minAge ago is
// spared, which covers uploads in a process this lock cannot see.
func (s *Store) Sweep(live func() (map[string]bool, error), minAge time.Duration, dryRun bool) (SweepResult, error) {
	var out SweepResult
	s.mu.Lock()
	defer s.mu.Unlock()
	hashes, err := live()
	if err != nil {
		return out, err
	}
	cutoff := time.Now().Add(-minAge)
	err = filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// The staging directory holds partial uploads in flight, not content.
			if d.Name() == "tmp" && filepath.Dir(path) == s.root {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !ValidHash(name) || hashes[name] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if minAge > 0 && info.ModTime().After(cutoff) {
			return nil
		}
		out.Removed++
		out.Bytes += info.Size()
		if dryRun {
			return nil
		}
		return os.Remove(path)
	})
	return out, err
}
