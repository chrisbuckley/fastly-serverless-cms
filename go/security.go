package main

import (
	"crypto/subtle"
	"net"
	"net/url"
	"strings"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"

// securityHeaders is the set applied to every response (contract section 2).
var securityHeaders = [][2]string{
	{"Content-Security-Policy", contentSecurityPolicy},
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "strict-origin-when-cross-origin"},
	{"X-Frame-Options", "DENY"},
	{"Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"},
	{"Cross-Origin-Opener-Policy", "same-origin"},
}

// applySecurityHeaders sets the contract security headers; admin routes also
// get X-Robots-Tag.
func applySecurityHeaders(h fsthttp.Header, path string) {
	for _, kv := range securityHeaders {
		h.Set(kv[0], kv[1])
	}
	if isAdminPath(path) {
		h.Set("X-Robots-Tag", "noindex, nofollow")
	}
}

func isAdminPath(path string) bool {
	return path == "/admin" || strings.HasPrefix(path, "/admin/")
}

// OriginAuthOK compares the expected shared secret with the presented header
// value in constant time. A missing secret or header never passes.
func OriginAuthOK(expected, got string) bool {
	if expected == "" || got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

// IsSafeMethod reports whether the method is exempt from CSRF checks.
func IsSafeMethod(method string) bool {
	return method == "GET" || method == "HEAD"
}

// CSRFAllowed implements the contract section 3 decision for a state-changing
// admin request.
func CSRFAllowed(secFetchSite, origin, siteURL string) bool {
	if secFetchSite != "" {
		return secFetchSite == "same-origin" || secFetchSite == "none"
	}
	if origin == "" {
		return false
	}
	return sameOrigin(origin, siteURL)
}

func sameOrigin(a, b string) bool {
	ua, err := url.Parse(a)
	if err != nil || ua.Scheme == "" || ua.Host == "" {
		return false
	}
	ub, err := url.Parse(b)
	if err != nil || ub.Scheme == "" || ub.Host == "" {
		return false
	}
	return strings.EqualFold(ua.Scheme, ub.Scheme) && strings.EqualFold(ua.Host, ub.Host)
}

// TruncateIP anonymises a client address: IPv4 to /24, IPv6 to /48.
// Unparseable input yields an empty string.
func TruncateIP(raw string) string {
	ip := net.ParseIP(strings.TrimSpace(raw))
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.Mask(net.CIDRMask(24, 32)).String()
	}
	return ip.Mask(net.CIDRMask(48, 128)).String()
}

// clientIP returns the real client address, trusted once origin auth passed.
func clientIP(r *fsthttp.Request) string {
	if ip := r.Header.Get("Fastly-Client-IP"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
