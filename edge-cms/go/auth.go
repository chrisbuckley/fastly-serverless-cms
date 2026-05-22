package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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

// CreateSessionToken builds an HMAC-SHA256 signed session token.
// The token format is "{expiry}.{base64(signature)}" where expiry is the
// unix timestamp at which the token expires (now + ttlSeconds).
func CreateSessionToken(key []byte, ttlSeconds int64) string {
	expiry := time.Now().Unix() + ttlSeconds
	expiryStr := strconv.FormatInt(expiry, 10)

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(expiryStr))
	sig := mac.Sum(nil)

	return fmt.Sprintf("%s.%s", expiryStr, base64.StdEncoding.EncodeToString(sig))
}

// VerifySessionToken validates an HMAC-SHA256 signed session token.
// Returns ErrInvalidToken if the format is wrong or the signature doesn't
// match, and ErrSessionExpired if the token has passed its expiry time.
func VerifySessionToken(key []byte, token string) error {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return ErrInvalidToken
	}

	expiryStr := parts[0]
	sigB64 := parts[1]

	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return ErrInvalidToken
	}

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(expiryStr))
	expected := mac.Sum(nil)

	if !hmac.Equal(sig, expected) {
		return ErrInvalidToken
	}

	expiry, err := strconv.ParseInt(expiryStr, 10, 64)
	if err != nil {
		return ErrInvalidToken
	}

	if time.Now().Unix() > expiry {
		return ErrSessionExpired
	}

	return nil
}

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
