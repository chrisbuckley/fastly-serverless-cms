package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// sha256Hex returns the SHA-256 hash of data as a lowercase hex string.
func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// hmacSHA256Raw returns the raw HMAC-SHA256 of data using the given key.
func hmacSHA256Raw(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// deriveSigningKey performs the AWS SigV4 key derivation:
// HMAC chain of "AWS4"+secretKey -> date -> region -> service -> "aws4_request"
func deriveSigningKey(secretKey, date, region, service string) []byte {
	kDate := hmacSHA256Raw([]byte(fmt.Sprintf("AWS4%s", secretKey)), []byte(date))
	kRegion := hmacSHA256Raw(kDate, []byte(region))
	kService := hmacSHA256Raw(kRegion, []byte(service))
	return hmacSHA256Raw(kService, []byte("aws4_request"))
}

// signSigV4 computes HMAC-SHA256 of stringToSign with signingKey, returns hex.
func signSigV4(signingKey []byte, stringToSign string) string {
	return hex.EncodeToString(hmacSHA256Raw(signingKey, []byte(stringToSign)))
}

// utcDatetime returns the current UTC time as (datetime, date),
// e.g. ("20260521T134000Z", "20260521").
func utcDatetime() (datetime, date string) {
	now := time.Now().UTC()
	datetime = now.Format("20060102T150405Z")
	date = datetime[:8]
	return datetime, date
}
