// SPDX-License-Identifier: MIT

package store

import (
	"path/filepath"
	"testing"
)

// An empty page answers with the current seq, so the client's cursor can catch up
// with changes that are gone from the log. Read after the page, that seq could
// already count a write committed in between, and the cursor moved past a change
// the client was never shown. Both now come from one snapshot.
func TestAWriteLandingDuringAnEmptyPageIsNotSkipped(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "meta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	changesGap = func() {
		if _, err := s.Put(PutArgs{Path: "late.md", Hash: "h", Size: 1, Mtime: 1}); err != nil {
			t.Error(err)
		}
	}
	entries, next, _, err := s.Changes(0, 100)
	changesGap = nil
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the page was read before the write, yet shows %+v", entries)
	}

	entries, _, _, err = s.Changes(next, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "late.md" {
		t.Fatalf("the cursor (%d) moved past a write that landed during the empty page", next)
	}
}
