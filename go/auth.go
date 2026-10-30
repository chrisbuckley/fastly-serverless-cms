package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidToken    = errors.New("invalid session token")
	ErrSessionExpired  = errors.New("session expired")
	ErrInvalidPassword = errors.New("invalid password")
)

const (
	sessionVersion = "v1"
	sessionTTL     = 3600
	nonceBytes     = 16
	revokedPrefix  = "session-revoked:"
)

// Session is the parsed, signature-verified content of a session token.
type Session struct {
	Expires int64
	Nonce   string
}

func signSession(key []byte, payload string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

// CreateSessionToken builds a session token of the form
// "v1.<expires_unix>.<nonce>.<b64sig>", where nonce is 16 random bytes in hex
// and sig is HMAC-SHA256 over "v1.<expires>.<nonce>".
func CreateSessionToken(key []byte, ttlSeconds int64) (string, error) {
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate session nonce: %w", err)
	}
	expiry := time.Now().Unix() + ttlSeconds
	payload := fmt.Sprintf("%s.%d.%s", sessionVersion, expiry, hex.EncodeToString(nonce))
	sig := signSession(key, payload)
	return payload + "." + base64.StdEncoding.EncodeToString(sig), nil
}

// ParseSessionToken validates a session token and returns its content.
// It returns ErrInvalidToken for malformed or forged tokens (including the
// legacy two-part format) and ErrSessionExpired once the expiry has passed.
func ParseSessionToken(key []byte, token string) (Session, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 4 || parts[0] != sessionVersion || !validNonce(parts[2]) {
		return Session{}, ErrInvalidToken
	}
	sig, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return Session{}, ErrInvalidToken
	}
	payload := strings.Join(parts[:3], ".")
	if !hmac.Equal(sig, signSession(key, payload)) {
		return Session{}, ErrInvalidToken
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return Session{}, ErrInvalidToken
	}
	if time.Now().Unix() > expiry {
		return Session{}, ErrSessionExpired
	}
	return Session{Expires: expiry, Nonce: parts[2]}, nil
}

// VerifySessionToken is ParseSessionToken without the parsed result.
func VerifySessionToken(key []byte, token string) error {
	_, err := ParseSessionToken(key, token)
	return err
}

func validNonce(n string) bool {
	if len(n) != nonceBytes*2 {
		return false
	}
	_, err := hex.DecodeString(n)
	return err == nil
}

// RevocationKey returns the KV key that marks a session nonce as logged out.
func RevocationKey(nonce string) string { return revokedPrefix + nonce }

// VerifyPassword checks a plaintext password against a bcrypt hash.
// Returns ErrInvalidPassword if the password does not match.
func VerifyPassword(password, hash string) error {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	if err != nil {
		return ErrInvalidPassword
	}
	return nil
}

// ExtractCookie parses a Cookie header string and returns the value for the
// named cookie. Returns an empty string if the cookie is not found.
func ExtractCookie(header, name string) string {
	pairs := strings.Split(header, ";")
	for _, pair := range pairs {
		pair = strings.TrimSpace(pair)
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) == 2 && parts[0] == name {
			return parts[1]
		}
	}
	return ""
}

// SessionCookie returns a Set-Cookie header value for a session token.
func SessionCookie(token string) string {
	return fmt.Sprintf("session=%s; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600", token)
}

// ClearSessionCookie returns a Set-Cookie header value that clears the session cookie.
func ClearSessionCookie() string {
	return "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0"
}
