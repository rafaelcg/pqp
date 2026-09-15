package control

import (
	"sync"
	"time"
)

// nonceCache remembers every X-Pqp-Remux-Nonce this box has accepted (a
// signature already verified) for ttl, refusing an exact repeat within
// that window: the replay protection NonceHeader's own doc comment
// describes (Farol review, PR #584). Bounded by construction, not by a
// capacity limit: entries older than ttl are swept opportunistically on
// every check, and this box's own control-route traffic is low-QPS (a
// handful of session start/stop/list calls, never a hot path), so the
// live set at any instant is small regardless of how long the process
// runs.
type nonceCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
	ttl  time.Duration
}

// newNonceCache returns a cache that treats a nonce as fresh again once ttl
// has passed since it was last accepted.
func newNonceCache(ttl time.Duration) *nonceCache {
	return &nonceCache{seen: make(map[string]time.Time), ttl: ttl}
}

// checkAndRemember reports whether nonce is new (never accepted within
// ttl of now) and, if so, records it at now. A false return means a
// replay: the caller must refuse the request.
func (c *nonceCache) checkAndRemember(nonce string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	for k, t := range c.seen {
		if now.Sub(t) > c.ttl {
			delete(c.seen, k)
		}
	}

	if t, ok := c.seen[nonce]; ok && now.Sub(t) <= c.ttl {
		return false
	}
	c.seen[nonce] = now
	return true
}
