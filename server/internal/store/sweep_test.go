// SPDX-License-Identifier: MIT

package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cuongnbms/obsidian-vaultsync/server/internal/store"
)

func liveOf(m map[string]bool) func() (map[string]bool, error) {
	return func() (map[string]bool, error) { return m, nil }
}

// A blob is written before the row that points at it is committed. A sweep that
// lands in between sees an orphan, so a sweep that cannot hold uploads off (the
// gc command runs in a process of its own) spares anything younger than its grace
// period.
func TestSweepSparesBlobsYoungerThanTheGracePeriod(t *testing.T) {
	files, blobs, dir := open(t)
	hash, _, err := blobs.Put(strings.NewReader("upload in flight"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blobs.Sweep(files.LiveHashes, time.Hour, false); err != nil {
		t.Fatal(err)
	}
	if !blobs.Has(hash) {
		t.Fatal("a blob written a moment ago was swept")
	}
	age(t, dir, hash, 2*time.Hour)
	if _, err := blobs.Sweep(files.LiveHashes, time.Hour, false); err != nil {
		t.Fatal(err)
	}
	if blobs.Has(hash) {
		t.Fatal("an orphan older than the grace period survived")
	}
}

// An upload whose content is already on disk reuses the blob. That blob may be
// old and about to lose its last reference, so reusing it counts as writing it.
func TestReusingAnOldBlobRestartsItsGracePeriod(t *testing.T) {
	files, blobs, dir := open(t)
	hash, _, err := blobs.Put(strings.NewReader("same bytes"), 0)
	if err != nil {
		t.Fatal(err)
	}
	age(t, dir, hash, 2*time.Hour)
	if _, _, err := blobs.Put(strings.NewReader("same bytes"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := blobs.Sweep(files.LiveHashes, time.Hour, false); err != nil {
		t.Fatal(err)
	}
	if !blobs.Has(hash) {
		t.Fatal("a blob reused by an upload in flight was swept")
	}
}

// The erase the encryption migration asks for cannot wait out a grace period, so
// it holds uploads off instead: a sweep waits for an upload that is between its
// blob and its commit, and then sees the committed row.
func TestSweepWaitsForAnUploadBeingCommitted(t *testing.T) {
	files, blobs, _ := open(t)
	staged, err := blobs.Stage(strings.NewReader("racing the sweep"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer staged.Discard()
	release := blobs.Hold()
	if err := staged.Commit(); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := blobs.Sweep(files.LiveHashes, 0, false)
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("the sweep ran while an upload was committing (err=%v)", err)
	case <-time.After(100 * time.Millisecond):
	}

	if _, err := files.Put(store.PutArgs{Path: "race.md", Hash: staged.Hash, Size: staged.Size, Mtime: 1}); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !blobs.Has(staged.Hash) {
		t.Fatal("the sweep deleted content committed while it waited")
	}
}

func age(t *testing.T, dir, hash string, by time.Duration) {
	t.Helper()
	old := time.Now().Add(-by)
	if err := os.Chtimes(filepath.Join(dir, "blobs", hash[:2], hash), old, old); err != nil {
		t.Fatal(err)
	}
}
