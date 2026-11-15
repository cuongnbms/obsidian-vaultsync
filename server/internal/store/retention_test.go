// SPDX-License-Identifier: MIT

package store_test

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/cuongnbms/obsidian-vaultsync/server/internal/store"
)

// The retention window counts from the moment a file was deleted. It used to count
// from the file's last edit, which the tombstone carried over, so a note untouched
// for two months was erased on the first sweep after it was deleted.

func TestDeletingAnOldNoteKeepsItForTheWholeWindow(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "old.md", "last edited two months ago", 1, 60)

	if _, err := files.Delete("old.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	n, err := files.ForgetDeleted(30)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("a note deleted just now was erased (%d forgotten)", n)
	}
	list, err := files.DeletedFiles(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Path != "old.md" {
		t.Fatalf("the deleted note is not offered for restore: %+v", list)
	}
	if age := time.Since(time.UnixMilli(list[0].DeletedAt)); age < 0 || age > time.Minute {
		t.Fatalf("deleted_at should be the moment of deletion, is %v ago", age)
	}
}

func TestADeletionPastTheWindowIsForgotten(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "old.md", "body", 1, 60)

	files.SetClock(func() time.Time { return time.Now().AddDate(0, 0, -31) })
	if _, err := files.Delete("old.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	files.SetClock(nil)

	n, err := files.ForgetDeleted(30)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("a deletion 31 days old outlived a 30-day window (%d forgotten)", n)
	}
}

func TestRenamingAnOldNoteDoesNotStartItsSourceOnTheWayOut(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "a.md", "body", 1, 60)

	if _, err := files.Rename("a.md", "b.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	if n, err := files.ForgetDeleted(30); err != nil || n != 0 {
		t.Fatalf("the rename's tombstone was erased at once (n=%d, err=%v)", n, err)
	}
	if f, err := files.Get("a.md"); err != nil || !f.Deleted {
		t.Fatalf("a.md should still be a tombstone: %+v, %v", f, err)
	}
}

func TestCollectForgetsOldDeletionsButNotRecentOnes(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "old.md", "gone long ago", 1, 200)
	write(t, files, blobs, "fresh.md", "gone today", 1, 200)

	files.SetClock(func() time.Time { return time.Now().AddDate(0, 0, -100) })
	if _, err := files.Delete("old.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	files.SetClock(nil)
	if _, err := files.Delete("fresh.md", 1, "test"); err != nil {
		t.Fatal(err)
	}

	res, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 20, TombstoneDays: 90})
	if err != nil {
		t.Fatal(err)
	}
	if res.TombstonesFreed != 1 {
		t.Fatalf("expected the 100-day-old deletion alone to go, %d went", res.TombstonesFreed)
	}
	if _, err := files.Get("old.md"); err == nil {
		t.Fatal("a deletion past the tombstone window survived")
	}
	if f, err := files.Get("fresh.md"); err != nil || !f.Deleted {
		t.Fatal("a recent deletion of an old note must stay recoverable")
	}
}

// A vault written by an older server holds tombstones dated by the last edit. The
// first open after the upgrade gives each a full window from now, rather than
// letting the sweep that runs at start-up erase them.
func TestTombstonesFromBeforeTheFixGetAFullWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meta.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().AddDate(0, 0, -200).UnixMilli()
	for _, q := range []string{
		`CREATE TABLE files (path TEXT PRIMARY KEY, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
		  hash TEXT, size INTEGER NOT NULL, mtime INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
		  folder INTEGER NOT NULL DEFAULT 0, updated_by TEXT, renamed_from TEXT)`,
		`CREATE TABLE revisions (path TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT,
		  mtime INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (path, rev))`,
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
		`INSERT INTO meta VALUES ('seq', '2')`,
		`INSERT INTO files VALUES ('gone.md', 2, 2, NULL, 0, ` + itoa(old) + `, 1, 0, 'old', NULL)`,
		`INSERT INTO revisions VALUES ('gone.md', 1, 'abc', ` + itoa(old) + `, 1)`,
		`INSERT INTO revisions VALUES ('gone.md', 2, NULL, ` + itoa(old) + `, 2)`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()

	files, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	if n, err := files.ForgetDeleted(30); err != nil || n != 0 {
		t.Fatalf("an old tombstone was erased on the first sweep after the upgrade (n=%d, err=%v)", n, err)
	}

	// Once only: a deletion made after the upgrade keeps its own date, and opening
	// the vault again does not hand it a fresh window.
	if _, err := files.Put(store.PutArgs{Path: "later.md", Hash: sha("x"), Size: 1, Mtime: old}); err != nil {
		t.Fatal(err)
	}
	files.SetClock(func() time.Time { return time.Now().AddDate(0, 0, -31) })
	if _, err := files.Delete("later.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	files.Close()
	files, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := files.ForgetDeleted(30); err != nil || n != 1 {
		t.Fatalf("expected only the post-upgrade deletion to go (n=%d, err=%v)", n, err)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
