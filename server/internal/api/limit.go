// SPDX-License-Identifier: MIT

package api

import (
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Failed attempts are counted per client: a wrong token, a join code that does
// not exist. Neither can be guessed in any number of tries, so this is not what
// keeps a vault safe. It keeps a flood of guesses from queueing in front of real
// requests on the one database connection tokens live on.
//
// Only failures spend. A device with a right token is never slowed down unless
// its address has itself just failed twenty times in a row.
const (
	failBurst  = 20
	failRefill = 3 * time.Second // one more attempt every three seconds
	maxClients = 10_000          // past this, clients with a full allowance are forgotten
)

type limiter struct {
	mu      sync.Mutex
	clients map[string]*allowance
}

type allowance struct {
	left float64
	at   time.Time
}

func newLimiter() *limiter { return &limiter{clients: map[string]*allowance{}} }

func (l *limiter) refill(a *allowance, now time.Time) {
	a.left = math.Min(failBurst, a.left+float64(now.Sub(a.at))/float64(failRefill))
	a.at = now
}

// blocked says whether a client has no attempts left, and how long until it has.
func (l *limiter) blocked(client string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.clients[client]
	if !ok {
		return 0, false
	}
	l.refill(a, time.Now())
	if a.left >= 1 {
		return 0, false
	}
	return time.Duration((1 - a.left) * float64(failRefill)), true
}

// fail spends one attempt of a client's allowance.
func (l *limiter) fail(client string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	a, ok := l.clients[client]
	if !ok {
		if len(l.clients) >= maxClients {
			l.forgetIdle(now)
		}
		a = &allowance{left: failBurst, at: now}
		l.clients[client] = a
	}
	l.refill(a, now)
	a.left = math.Max(0, a.left-1)
}

func (l *limiter) forgetIdle(now time.Time) {
	for k, a := range l.clients {
		l.refill(a, now)
		if a.left >= failBurst {
			delete(l.clients, k)
		}
	}
}

// tooMany answers a client that has used up its attempts.
func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
	writeErr(w, http.StatusTooManyRequests, "too_many_attempts", "too many failed attempts from this address; try again shortly")
}

// clientAddr is who is asking. The server sits behind a reverse proxy, so the
// peer is the proxy, and the client is the last address in X-Forwarded-For: the
// one the proxy appended. Entries before it came from the client and could say
// anything.
//
// The proxy is a loopback peer with the installer, and a private one with the
// container, whose published port arrives through the Docker bridge. Without
// believing those, every client would share the proxy's allowance and one
// guesser would lock everybody out. A public peer is the client itself.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip == nil || !(ip.IsLoopback() || ip.IsPrivate()) {
		return host
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return host
	}
	hops := strings.Split(values[len(values)-1], ",")
	if last := strings.TrimSpace(hops[len(hops)-1]); last != "" {
		return last
	}
	return host
}

// smallBodyTimeout bounds how long a request with a small JSON body may take to
// send it. The server has no global read timeout, because uploads of large files
// take as long as they take; a slow trickle into a 1 KiB body is no upload.
const smallBodyTimeout = 15 * time.Second

func smallBody(w http.ResponseWriter, r *http.Request, max int64) io.Reader {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(smallBodyTimeout))
	return io.LimitReader(r.Body, max)
}
