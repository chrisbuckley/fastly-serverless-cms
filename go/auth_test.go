package main

import (
	"errors"
	"testing"
)

func TestSignAndVerify(t *testing.T) {
	key := []byte("test-key")
	token := CreateSessionToken(key, 3600)
	if err := VerifySessionToken(key, token); err != nil {
		t.Fatalf("expected valid token, got error: %v", err)
	}
}

func TestExpiredRejected(t *testing.T) {
	key := []byte("test-key")
	token := CreateSessionToken(key, -1)
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
	token := CreateSessionToken(key, 3600)
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
	token := CreateSessionToken(key1, 3600)
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
