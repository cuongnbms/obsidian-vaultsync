// SPDX-License-Identifier: MIT

package auth

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// Any device can hand a token to another device it owns. A stolen token can do
// the same, so the server remembers which token issued which: `token list` shows
// it, and revoking with cascade takes everything a lost device handed out.

func TestATokenRemembersWhichTokenIssuedIt(t *testing.T) {
	st := openAuth(t)
	laptopTok, _ := st.Add("laptop", "main")
	laptop, err := st.Resolve(laptopTok)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Issue("tablet", "main", laptop.ID); err != nil {
		t.Fatal(err)
	}
	code, err := st.CreateJoin("main", "phone", laptop, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.RedeemJoin(code); err != nil {
		t.Fatal(err)
	}

	by := map[string]string{}
	list, _ := st.List("main")
	for _, tok := range list {
		by[tok.Name] = tok.IssuedBy
	}
	want := map[string]string{"laptop": "", "tablet": "laptop", "phone": "laptop"}
	for name, issuer := range want {
		if by[name] != issuer {
			t.Fatalf("%s: issued by %q, want %q (list: %+v)", name, by[name], issuer, by)
		}
	}
}

func TestRevokingWithCascadeTakesEverythingTheTokenHandedOut(t *testing.T) {
	st := openAuth(t)
	laptopTok, _ := st.Add("laptop", "main")
	phoneTok, _ := st.Add("phone", "main") // added from the terminal, unrelated
	laptop, _ := st.Resolve(laptopTok)
	tabletTok, _ := st.Issue("tablet", "main", laptop.ID)
	tablet, _ := st.Resolve(tabletTok)
	watchTok, _ := st.Issue("watch", "main", tablet.ID)
	code, _ := st.CreateJoin("main", "spare", laptop, 15*time.Minute)

	n, err := st.Revoke("laptop", "main", true)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("expected laptop, tablet and watch to go, %d went", n)
	}
	for name, tok := range map[string]string{"laptop": laptopTok, "tablet": tabletTok, "watch": watchTok} {
		if _, err := st.Resolve(tok); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("%s still opens the vault", name)
		}
	}
	if _, err := st.Resolve(phoneTok); err != nil {
		t.Fatal("a token the laptop never issued was revoked with it")
	}
	if _, _, err := st.RedeemJoin(code); !errors.Is(err, ErrJoinInvalid) {
		t.Fatal("a join link the laptop made still turns into a token")
	}
}

func TestRevokingWithoutCascadeLeavesWhatTheTokenIssued(t *testing.T) {
	st := openAuth(t)
	laptopTok, _ := st.Add("laptop", "main")
	laptop, _ := st.Resolve(laptopTok)
	tabletTok, _ := st.Issue("tablet", "main", laptop.ID)

	if n, err := st.Revoke("laptop", "main", false); err != nil || n != 1 {
		t.Fatalf("revoke: n=%d err=%v", n, err)
	}
	if _, err := st.Resolve(tabletTok); err != nil {
		t.Fatal("a plain revoke took a token the device had issued")
	}
	list, _ := st.List("main")
	if len(list) != 1 || list[0].IssuedBy != "(revoked)" {
		t.Fatalf("the tablet should show its issuer as revoked: %+v", list)
	}
}

// A server.db written before the lineage columns existed opens, resolves its
// tokens and issues new ones.
func TestTokensFromAnOlderServerStillWork(t *testing.T) {
	path := t.TempDir() + "/server.db"
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	old := "obs_from-an-older-server"
	for _, q := range []string{
		`CREATE TABLE tokens (hash TEXT PRIMARY KEY, name TEXT NOT NULL, vault TEXT NOT NULL,
		  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE join_codes (hash TEXT PRIMARY KEY, vault TEXT NOT NULL, device TEXT NOT NULL,
		  issued_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
		  used_at INTEGER NOT NULL DEFAULT 0)`,
		`INSERT INTO tokens(hash,name,vault,created_at) VALUES('` + hashToken(old) + `','desk','main',1)`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()

	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	desk, err := st.Resolve(old)
	if err != nil {
		t.Fatalf("an existing token stopped working: %v", err)
	}
	if _, err := st.Issue("phone", "main", desk.ID); err != nil {
		t.Fatal(err)
	}
	if list, err := st.List(""); err != nil || len(list) != 2 {
		t.Fatalf("list: %+v, %v", list, err)
	}
}

func openAuth(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir() + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}
