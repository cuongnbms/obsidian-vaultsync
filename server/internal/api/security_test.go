// SPDX-License-Identifier: MIT

package api_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cuongnbms/obsidian-vaultsync/server/internal/api"
	"github.com/cuongnbms/obsidian-vaultsync/server/internal/auth"
	"github.com/cuongnbms/obsidian-vaultsync/server/internal/blob"
	"github.com/cuongnbms/obsidian-vaultsync/server/internal/store"
)

// The device a migration belongs to is the token that started it. X-Device is
// what a device says it is called, and any device can say it is called anything.
func TestTheMigrationLockCannotBeWalkedThroughByNamingTheMigratingDevice(t *testing.T) {
	h := newHarness(t)
	h.do(h.deskTok, "PUT", "/v1/vaultkey", strings.NewReader(`{"v":1}`), nil)
	if resp, body := h.do(h.deskTok, "PUT", "/v1/vaultkey/migration", nil, map[string]string{"X-Device": "Desk"}); resp.StatusCode != 200 {
		t.Fatalf("marker: %d %s", resp.StatusCode, body)
	}

	spoof := map[string]string{"X-Device": "Desk"}
	if r := h.put(h.phoneTok, "plain.md", 0, "readable", spoof); r.Status != http.StatusLocked {
		t.Fatalf("a write from another token under the migrating device's name got %d, want 423", r.Status)
	}
	_, body := h.do(h.phoneTok, "GET", "/v1/vaultkey", nil, spoof)
	var seen struct {
		Migration map[string]any `json:"migration"`
	}
	if err := json.Unmarshal(body, &seen); err != nil {
		t.Fatal(err)
	}
	if seen.Migration["mine"] != false || seen.Migration["device"] != "Desk" {
		t.Fatalf("the phone should see Desk's migration as not its own: %s", body)
	}
	if len(seen.Migration) != 3 {
		t.Fatalf("the marker should carry device, started and mine, and nothing that identifies a token: %s", body)
	}

	// The migrating token writes, whatever it calls itself today.
	if r := h.put(h.deskTok, "cipher", 0, "x", map[string]string{"X-Device": "Renamed desk"}); r.Status != 200 {
		t.Fatalf("the migrating token was locked out of its own migration: %d", r.Status)
	}
}

// A marker written by an older server names only a device; it is still honoured,
// by name, so a migration in flight across the upgrade keeps its lock.
func TestAMarkerFromAnOlderServerIsComparedByName(t *testing.T) {
	h := newHarness(t)
	h.do(h.deskTok, "PUT", "/v1/vaultkey", strings.NewReader(`{"v":1}`), nil)
	files := h.vault(t)
	if err := files.PutMeta("encrypting", `{"device":"desk-01","started":1}`); err != nil {
		t.Fatal(err)
	}
	if r := h.put(h.phoneTok, "late.md", 0, "x"); r.Status != http.StatusLocked {
		t.Fatalf("an old marker no longer locks other devices out: %d", r.Status)
	}
	if r := h.put(h.deskTok, "cipher", 0, "x"); r.Status != 200 {
		t.Fatalf("an old marker locked out the device it names: %d", r.Status)
	}
}

type brokenVaults struct{}

func (brokenVaults) Get(string) (*store.Store, *blob.Store, error) {
	return nil, nil, errors.New("open /srv/secret-data/vaults/main/meta.db: permission denied")
}

func TestServerFailuresDoNotTellTheClientWhereThingsLive(t *testing.T) {
	dir := t.TempDir()
	tokens, err := auth.Open(dir + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	defer tokens.Close()
	tok, _ := tokens.Add("desk", "main")
	srv := httptest.NewServer((&api.Server{Auth: tokens, Vaults: brokenVaults{}}).Handler())
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/v1/changes", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 500 {
		t.Fatalf("want 500, got %d", resp.StatusCode)
	}
	if strings.Contains(string(body), "/srv") || strings.Contains(string(body), "permission") {
		t.Fatalf("the response hands out server internals: %s", body)
	}
}

// Wrong tokens and join codes are counted per client. The server sits behind a
// proxy on the same machine, so the client is the address the proxy forwarded.
func TestGuessingTokensIsSlowedDownPerClient(t *testing.T) {
	h := newHarness(t)
	from := func(ip string) map[string]string { return map[string]string{"X-Forwarded-For": ip} }

	limited := false
	for i := 0; i < 40; i++ {
		resp, _ := h.do("obs_wrong", "GET", "/v1/changes", nil, from("198.51.100.7"))
		if resp.StatusCode == http.StatusTooManyRequests {
			limited = true
			if resp.Header.Get("Retry-After") == "" {
				t.Fatal("a 429 should say when to come back")
			}
			break
		}
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d: %d", i, resp.StatusCode)
		}
	}
	if !limited {
		t.Fatal("forty wrong tokens in a row were all answered")
	}

	// Somebody else is not punished for it.
	if resp, _ := h.do("obs_wrong", "GET", "/v1/changes", nil, from("198.51.100.8")); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("another client's first wrong token got %d", resp.StatusCode)
	}
	if resp, _ := h.do(h.deskTok, "GET", "/v1/changes", nil, from("198.51.100.8")); resp.StatusCode != 200 {
		t.Fatalf("another client's right token got %d", resp.StatusCode)
	}
	// A proxy hop the client added itself is not believed: the last entry is the
	// one the proxy wrote.
	if resp, _ := h.do("obs_wrong", "GET", "/v1/changes", nil, from("10.9.9.9, 198.51.100.7")); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("prefixing a made-up address escaped the limit: %d", resp.StatusCode)
	}
}

func TestRedeemingJoinCodesIsSlowedDownPerClient(t *testing.T) {
	h := newHarness(t)
	limited := false
	for i := 0; i < 40; i++ {
		resp, _ := h.do("", "POST", "/v1/join/redeem", strings.NewReader(`{"code":"guess"}`),
			map[string]string{"X-Forwarded-For": "198.51.100.9"})
		if resp.StatusCode == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("forty join code guesses in a row were all answered")
	}
}
