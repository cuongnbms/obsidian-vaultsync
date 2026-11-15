// SPDX-License-Identifier: MIT

package auth

import (
	"testing"
	"time"
)

// last_seen is for the operator's `token list`, to the hour at best. Writing it on
// every request put a synced commit in front of every call, on the one connection
// all vaults share.
func TestLastSeenIsWrittenAtMostOnceAnHour(t *testing.T) {
	st, err := Open(t.TempDir() + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	tok, err := st.Add("phone", "main")
	if err != nil {
		t.Fatal(err)
	}
	seen := func() int64 {
		var v int64
		if err := st.db.QueryRow(`SELECT last_seen FROM tokens WHERE hash=?`, hashToken(tok)).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	setSeen := func(v int64) {
		if _, err := st.db.Exec(`UPDATE tokens SET last_seen=? WHERE hash=?`, v, hashToken(tok)); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := st.Resolve(tok); err != nil {
		t.Fatal(err)
	}
	if time.Since(time.Unix(seen(), 0)) > time.Minute {
		t.Fatal("a token never seen before should be marked seen")
	}

	recent := time.Now().Add(-10 * time.Minute).Unix()
	setSeen(recent)
	if _, err := st.Resolve(tok); err != nil {
		t.Fatal(err)
	}
	if seen() != recent {
		t.Fatal("last_seen was rewritten although it was ten minutes old")
	}

	setSeen(time.Now().Add(-2 * time.Hour).Unix())
	if _, err := st.Resolve(tok); err != nil {
		t.Fatal(err)
	}
	if time.Since(time.Unix(seen(), 0)) > time.Minute {
		t.Fatal("last_seen two hours old should have been brought up to date")
	}
}
