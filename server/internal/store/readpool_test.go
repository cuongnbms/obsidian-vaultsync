// SPDX-License-Identifier: MIT

package store

import (
	"path/filepath"
	"testing"
	"time"
)

// Reads go through a pool of their own. On the single writer connection, every
// download queued behind every other download's queries and behind any write in
// progress, which undid the parallel pull.
func TestReadsDoNotWaitForAWriteInProgress(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "meta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Put(PutArgs{Path: "a.md", Hash: "h1", Size: 1, Mtime: 1}); err != nil {
		t.Fatal(err)
	}

	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE files SET hash='uncommitted' WHERE path='a.md'`); err != nil {
		t.Fatal(err)
	}

	got := make(chan File, 1)
	go func() {
		f, _ := s.Get("a.md")
		got <- f
	}()
	select {
	case f := <-got:
		if f.Hash != "h1" {
			t.Fatalf("a read saw a write that was never committed: %q", f.Hash)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a read waited for a write transaction to finish")
	}
}

// The read pool cannot write, so nothing that has to be one transaction with the
// seq counter can end up on it by mistake.
func TestTheReadPoolRefusesWrites(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "meta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.rdb.Exec(`INSERT INTO meta(key,value) VALUES('x','y')`); err == nil {
		t.Fatal("the read pool accepted a write")
	}
}
