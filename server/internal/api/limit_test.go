// SPDX-License-Identifier: MIT

package api

import (
	"net/http/httptest"
	"testing"
)

func TestTheClientIsWhoTheProxySaysWhenThereIsAProxy(t *testing.T) {
	cases := []struct {
		name, peer string
		xff        []string
		want       string
	}{
		{"installer: proxy on loopback", "127.0.0.1:40000", []string{"203.0.113.4"}, "203.0.113.4"},
		{"container: proxy through the Docker bridge", "172.17.0.1:40000", []string{"203.0.113.4"}, "203.0.113.4"},
		{"a hop the client made up is ignored", "127.0.0.1:40000", []string{"10.0.0.1, 203.0.113.4"}, "203.0.113.4"},
		{"of several headers, the proxy's is the last", "127.0.0.1:40000", []string{"10.0.0.1", "203.0.113.4"}, "203.0.113.4"},
		{"no header: the peer", "127.0.0.1:40000", nil, "127.0.0.1"},
		{"a public peer is the client, whatever it claims", "198.51.100.2:40000", []string{"203.0.113.4"}, "198.51.100.2"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/v1/changes", nil)
			r.RemoteAddr = c.peer
			for _, v := range c.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := clientAddr(r); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestAnAllowanceComesBackWithTime(t *testing.T) {
	l := newLimiter()
	for i := 0; i < failBurst; i++ {
		l.fail("x")
	}
	if _, blocked := l.blocked("x"); !blocked {
		t.Fatal("a client that used its whole allowance is not blocked")
	}
	l.clients["x"].at = l.clients["x"].at.Add(-failRefill)
	if _, blocked := l.blocked("x"); blocked {
		t.Fatal("one refill period later the client should have an attempt back")
	}
	if _, blocked := l.blocked("y"); blocked {
		t.Fatal("a client never seen is blocked")
	}
}
