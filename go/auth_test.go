package main

import (
	"errors"
	"regexp"
	"strings"
	"testing"
)

func mustToken(t *testing.T, key []byte, ttl int64) string {
	t.Helper()
	token, err := CreateSessionToken(key, ttl)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestSignAndVerify(t *testing.T) {
	key := []byte("test-key")
	token := mustToken(t, key, 3600)
	if err := VerifySessionToken(key, token); err != nil {
		t.Fatalf("expected valid token, got error: %v", err)
	}
}

func TestExpiredRejected(t *testing.T) {
	key := []byte("test-key")
	token := mustToken(t, key, -1)
	err := VerifySessionToken(key, token)
	if err == nil {
		t.Fatal("expected error for expired token, got nil")
	}
	if !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expected ErrSessionExpired, got: %v", err)
	}
}

func TestTamperedRejected(t *testing.T) {
	key := []byte("test-key")
	token := mustToken(t, key, 3600)
	tampered := token + "x"
	err := VerifySessionToken(key, tampered)
	if err == nil {
		t.Fatal("expected error for tampered token, got nil")
	}
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken, got: %v", err)
	}
}

func TestWrongKeyRejected(t *testing.T) {
	key1 := []byte("key-one")
	key2 := []byte("key-two")
	token := mustToken(t, key1, 3600)
	err := VerifySessionToken(key2, token)
	if err == nil {
		t.Fatal("expected error for wrong key, got nil")
	}
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken, got: %v", err)
	}
}

func TestParseCookie(t *testing.T) {
	header := "session=abc; other=xyz"

	if v := ExtractCookie(header, "session"); v != "abc" {
		t.Fatalf("expected 'abc', got '%s'", v)
	}
	if v := ExtractCookie(header, "other"); v != "xyz" {
		t.Fatalf("expected 'xyz', got '%s'", v)
	}
	if v := ExtractCookie(header, "missing"); v != "" {
		t.Fatalf("expected '', got '%s'", v)
	}
}

func TestTokenFormat(t *testing.T) {
	token := mustToken(t, []byte("k"), 3600)
	re := regexp.MustCompile(`^v1\.\d+\.[0-9a-f]{32}\.[A-Za-z0-9+/]+=*$`)
	if !re.MatchString(token) {
		t.Fatalf("token %q does not match v1.<exp>.<nonce>.<sig>", token)
	}
}

func TestTokenNoncesUnique(t *testing.T) {
	key := []byte("k")
	a, b := mustToken(t, key, 3600), mustToken(t, key, 3600)
	sa, _ := ParseSessionToken(key, a)
	sb, _ := ParseSessionToken(key, b)
	if sa.Nonce == sb.Nonce {
		t.Fatal("nonces must differ")
	}
}

func TestParseSessionTokenRejects(t *testing.T) {
	key := []byte("k")
	good := mustToken(t, key, 3600)
	parts := strings.Split(good, ".")
	tests := []struct {
		name  string
		token string
		want  error
	}{
		{"legacy two-part", "9999999999.c2ln", ErrInvalidToken},
		{"empty", "", ErrInvalidToken},
		{"wrong version", "v2." + strings.Join(parts[1:], "."), ErrInvalidToken},
		{"short nonce", strings.Join([]string{"v1", parts[1], "abcd", parts[3]}, "."), ErrInvalidToken},
		{"non-hex nonce", strings.Join([]string{"v1", parts[1], strings.Repeat("z", 32), parts[3]}, "."), ErrInvalidToken},
		{"tampered expiry", strings.Join([]string{"v1", "9999999999", parts[2], parts[3]}, "."), ErrInvalidToken},
		{"tampered nonce", strings.Join([]string{"v1", parts[1], strings.Repeat("0", 32), parts[3]}, "."), ErrInvalidToken},
		{"bad base64", strings.Join([]string{"v1", parts[1], parts[2], "!!!"}, "."), ErrInvalidToken},
		{"extra part", good + ".x", ErrInvalidToken},
	}
	for _, tt := range tests {
		if _, err := ParseSessionToken(key, tt.token); !errors.Is(err, tt.want) {
			t.Errorf("%s: got %v want %v", tt.name, err, tt.want)
		}
	}
}

func TestParseSessionTokenReturnsNonce(t *testing.T) {
	key := []byte("k")
	token := mustToken(t, key, 3600)
	s, err := ParseSessionToken(key, token)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(token, ".")[2]
	if s.Nonce != got {
		t.Errorf("nonce %q != %q", s.Nonce, got)
	}
	if RevocationKey(s.Nonce) != "session-revoked:"+got {
		t.Errorf("bad revocation key %q", RevocationKey(s.Nonce))
	}
}
