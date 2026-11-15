// SPDX-License-Identifier: MIT

// Package auth handles bearer tokens. One token = one device = one vault.
//
// Tokens are generated on the server and pasted into the plugin by hand: on mobile
// that is the only sane option, since OAuth there is misery.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"

	_ "modernc.org/sqlite"
)

var ErrUnauthorized = errors.New("unauthorized")

var vaultRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// ValidVault limits a vault name to what is safe to put in a filesystem path.
func ValidVault(v string) bool { return vaultRe.MatchString(v) && v != "." && v != ".." }

type Token struct {
	// ID identifies the token without being it: the sha256 that is stored. It is
	// what the server compares when it has to know which device is asking, since
	// the name a device sends about itself is only what it says.
	ID        string
	Name      string
	Vault     string
	CreatedAt time.Time
	LastSeen  time.Time
	// The name of the token that issued this one. Empty when it was made from the
	// terminal, "(revoked)" when its issuer has been revoked since.
	IssuedBy string
}

type Store struct{ db *sql.DB }

// issued_by on tokens is the ID of the issuing token; issued_by on join_codes is
// the issuer's name, for the page, and issuer_id its ID.
const schema = `
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  vault      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  issued_by  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tokens_vault ON tokens(vault);
CREATE TABLE IF NOT EXISTS join_codes (
  hash       TEXT PRIMARY KEY,
  vault      TEXT NOT NULL,
  device     TEXT NOT NULL,
  issued_by  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0,
  issuer_id  TEXT NOT NULL DEFAULT ''
);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// CREATE TABLE IF NOT EXISTS leaves a table from an older server as it was.
	for _, c := range []struct{ table, column string }{
		{"tokens", "issued_by"},
		{"join_codes", "issuer_id"},
	} {
		if err := addColumn(db, c.table, c.column); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate %s.%s: %w", c.table, c.column, err)
		}
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_tokens_issued_by ON tokens(issued_by)`); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// addColumn adds a text column defaulting to ” unless the table already has it.
func addColumn(db *sql.DB, table, column string) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	_, err = db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` TEXT NOT NULL DEFAULT ''`)
	return err
}

func (s *Store) Close() error { return s.db.Close() }

func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// Add issues a new token from the terminal. The plaintext value is returned
// exactly once — only its sha256 is ever stored on disk.
func (s *Store) Add(name, vault string) (string, error) {
	return s.Issue(name, vault, "")
}

// Issue issues a new token on behalf of the token with ID issuer, and remembers
// that it did, so a lost device can be revoked with everything it handed out.
func (s *Store) Issue(name, vault, issuer string) (string, error) {
	if !ValidVault(vault) {
		return "", fmt.Errorf("invalid vault name %q", vault)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	tok := "obs_" + base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.db.Exec(`INSERT INTO tokens(hash,name,vault,created_at,issued_by) VALUES(?,?,?,?,?)`,
		hashToken(tok), name, vault, time.Now().Unix(), issuer)
	if err != nil {
		return "", err
	}
	return tok, nil
}

const lastSeenEvery = time.Hour

// Resolve validates a token and returns the vault it is bound to.
func (s *Store) Resolve(tok string) (Token, error) {
	if tok == "" {
		return Token{}, ErrUnauthorized
	}
	h := hashToken(tok)
	var t Token
	var created, seen int64
	var gotHash string
	err := s.db.QueryRow(`SELECT hash,name,vault,created_at,last_seen FROM tokens WHERE hash=?`, h).
		Scan(&gotHash, &t.Name, &t.Vault, &created, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, ErrUnauthorized
	}
	if err != nil {
		return Token{}, err
	}
	// The comparison is constant-time even though the indexed lookup already
	// happened: keeping the habit is the only protection left if the schema changes.
	if subtle.ConstantTimeCompare([]byte(gotHash), []byte(h)) != 1 {
		return Token{}, ErrUnauthorized
	}
	t.ID = h
	t.CreatedAt = time.Unix(created, 0)
	t.LastSeen = time.Unix(seen, 0)
	// last_seen is read by a person in `token list`, to the hour at best. Writing
	// it on every request put a synced commit in front of every call, on the one
	// connection every vault shares, and serialised parallel downloads behind it.
	if now := time.Now(); now.Sub(t.LastSeen) >= lastSeenEvery {
		_, _ = s.db.Exec(`UPDATE tokens SET last_seen=? WHERE hash=?`, now.Unix(), h)
	}
	return t, nil
}

// List returns every token, or only one vault's when vault is non-empty. The
// vault column is always populated so a caller listing everything can still tell
// them apart.
func (s *Store) List(vault string) ([]Token, error) {
	q := `SELECT t.hash, t.name, t.vault, t.created_at, t.last_seen, t.issued_by, p.name
		FROM tokens t LEFT JOIN tokens p ON p.hash = t.issued_by`
	var rows *sql.Rows
	var err error
	if vault == "" {
		rows, err = s.db.Query(q + ` ORDER BY t.vault, t.created_at`)
	} else {
		rows, err = s.db.Query(q+` WHERE t.vault=? ORDER BY t.created_at`, vault)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var created, seen int64
		var issuer string
		var issuerName sql.NullString
		if err := rows.Scan(&t.ID, &t.Name, &t.Vault, &created, &seen, &issuer, &issuerName); err != nil {
			return nil, err
		}
		t.CreatedAt, t.LastSeen = time.Unix(created, 0), time.Unix(seen, 0)
		switch {
		case issuer == "":
		case issuerName.Valid:
			t.IssuedBy = issuerName.String
		default:
			t.IssuedBy = "(revoked)"
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Revoke removes a token by device name. When vault is non-empty only that vault's
// token is removed, so a device named the same in two vaults can be revoked from
// one without touching the other.
//
// With cascade, every token the revoked ones issued goes too, and the tokens those
// issued, and every unspent join link any of them made. That is the answer to a
// lost or stolen device, which could have handed itself as many tokens as it
// liked under any names. Without it, devices the revoked one set up keep working.
func (s *Store) Revoke(name, vault string, cascade bool) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	q, args := `SELECT hash FROM tokens WHERE name=?`, []any{name}
	if vault != "" {
		q, args = q+` AND vault=?`, append(args, vault)
	}
	ids, err := column(tx, q, args...)
	if err != nil {
		return 0, err
	}
	if cascade {
		for frontier := ids; len(frontier) > 0; {
			var next []string
			for _, id := range frontier {
				children, err := column(tx, `SELECT hash FROM tokens WHERE issued_by=?`, id)
				if err != nil {
					return 0, err
				}
				next = append(next, children...)
			}
			ids = append(ids, next...)
			frontier = next
		}
	}
	var n int64
	for _, id := range ids {
		res, err := tx.Exec(`DELETE FROM tokens WHERE hash=?`, id)
		if err != nil {
			return 0, err
		}
		got, _ := res.RowsAffected()
		n += got
		if cascade {
			if _, err := tx.Exec(`DELETE FROM join_codes WHERE issuer_id=? AND used_at=0`, id); err != nil {
				return 0, err
			}
		}
	}
	return n, tx.Commit()
}

func column(tx *sql.Tx, q string, args ...any) ([]string, error) {
	rows, err := tx.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// A join code stands in for a token on the way to a new device.
//
// The setup link used to carry the token itself, so a photographed screen or a
// forwarded message was the vault. A code is short-lived and single-use, and turns
// into a token only when the other device presses Connect; the link a camera saw
// five minutes ago is by then just a picture.
type Join struct {
	Vault     string
	Device    string
	IssuedBy  string
	ExpiresAt time.Time
	issuerID  string
}

// ErrJoinInvalid covers missing, expired and already used codes alike: telling the
// three apart helps nobody who is holding the wrong link.
var ErrJoinInvalid = errors.New("join code is invalid, expired or already used")

// CreateJoin mints a code for one device. Expired codes are swept on the way, so the
// table never grows past what was issued recently.
func (s *Store) CreateJoin(vault, device string, issuer Token, ttl time.Duration) (string, error) {
	if !ValidVault(vault) {
		return "", fmt.Errorf("invalid vault name %q", vault)
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	_, _ = s.db.Exec(`DELETE FROM join_codes WHERE expires_at < ? OR used_at > 0`, now.Add(-24*time.Hour).Unix())
	_, err := s.db.Exec(`INSERT INTO join_codes(hash,vault,device,issued_by,created_at,expires_at,issuer_id)
		VALUES(?,?,?,?,?,?,?)`, hashToken(code), vault, device, issuer.Name, now.Unix(), now.Add(ttl).Unix(), issuer.ID)
	if err != nil {
		return "", err
	}
	return code, nil
}

// PeekJoin says what a code is for without spending it: the page that shows the
// steps needs the device name, and showing the page is not yet joining.
func (s *Store) PeekJoin(code string) (Join, error) {
	var j Join
	var expires, used int64
	err := s.db.QueryRow(`SELECT vault,device,issued_by,issuer_id,expires_at,used_at FROM join_codes WHERE hash=?`,
		hashToken(code)).Scan(&j.Vault, &j.Device, &j.IssuedBy, &j.issuerID, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return Join{}, ErrJoinInvalid
	}
	if err != nil {
		return Join{}, err
	}
	j.ExpiresAt = time.Unix(expires, 0)
	if used > 0 || time.Now().After(j.ExpiresAt) {
		return Join{}, ErrJoinInvalid
	}
	return j, nil
}

// RedeemJoin spends a code and returns the token it stood for. The spend is one
// statement guarded by the unused-and-unexpired condition, so two devices racing
// for the same code cannot both win.
func (s *Store) RedeemJoin(code string) (string, Join, error) {
	j, err := s.PeekJoin(code)
	if err != nil {
		return "", Join{}, err
	}
	res, err := s.db.Exec(`UPDATE join_codes SET used_at=? WHERE hash=? AND used_at=0 AND expires_at>=?`,
		time.Now().Unix(), hashToken(code), time.Now().Unix())
	if err != nil {
		return "", Join{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", Join{}, ErrJoinInvalid
	}
	tok, err := s.Issue(j.Device, j.Vault, j.issuerID)
	if err != nil {
		return "", Join{}, err
	}
	return tok, j, nil
}
