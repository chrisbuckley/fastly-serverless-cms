package main

import (
	"testing"

	"github.com/fastly/compute-sdk-go/fsthttp"
)

func TestRateLimitKey(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"ipv4 unchanged", "203.0.113.7", "203.0.113.7"},
		{"ipv6 full", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"},
		{"ipv6 same /64", "2001:db8:1:2::1", "2001:db8:1:2::/64"},
		{"ipv6 short", "2001:db8::1", "2001:db8::/64"},
		{"ipv6 zone dropped", "fe80::1%eth0", "fe80::/64"},
		{"ipv4-mapped ipv6", "::ffff:198.51.100.9", "198.51.100.9"},
		{"unparseable", "not-an-ip", "not-an-ip"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		if got := rateLimitKey(tt.in); got != tt.want {
			t.Errorf("%s: rateLimitKey(%q) = %q want %q", tt.name, tt.in, got, tt.want)
		}
	}
}

func TestOriginAuthOK(t *testing.T) {
	tests := []struct {
		name          string
		expected, got string
		want          bool
	}{
		{"match", "s3cret", "s3cret", true},
		{"mismatch", "s3cret", "other", false},
		{"missing header", "s3cret", "", false},
		{"missing secret", "", "x", false},
		{"both empty", "", "", false},
		{"prefix", "s3cret", "s3cre", false},
	}
	for _, tt := range tests {
		if got := OriginAuthOK(tt.expected, tt.got); got != tt.want {
			t.Errorf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
}

func TestCSRFAllowed(t *testing.T) {
	const site = "https://example.com"
	tests := []struct {
		name                   string
		fetchSite, origin, url string
		want                   bool
	}{
		{"same-origin", "same-origin", "", site, true},
		{"none", "none", "", site, true},
		{"same-site rejected", "same-site", "", site, false},
		{"cross-site rejected", "cross-site", "", site, false},
		{"fetch-site wins over good origin", "cross-site", site, site, false},
		{"origin match", "", "https://example.com", site, true},
		{"origin match case", "", "https://EXAMPLE.com", site, true},
		{"origin scheme mismatch", "", "http://example.com", site, false},
		{"origin host mismatch", "", "https://evil.com", site, false},
		{"origin suffix trick", "", "https://example.com.evil.com", site, false},
		{"origin port mismatch", "", "https://example.com:8443", site, false},
		{"origin with port match", "", "http://127.0.0.1:7676", "http://127.0.0.1:7676", true},
		{"origin null", "", "null", site, false},
		{"neither", "", "", site, false},
	}
	for _, tt := range tests {
		if got := CSRFAllowed(tt.fetchSite, tt.origin, tt.url); got != tt.want {
			t.Errorf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
}

func TestIsSafeMethod(t *testing.T) {
	for m, want := range map[string]bool{"GET": true, "HEAD": true, "POST": false, "PUT": false, "DELETE": false} {
		if IsSafeMethod(m) != want {
			t.Errorf("IsSafeMethod(%s) != %v", m, want)
		}
	}
}

func TestTruncateIP(t *testing.T) {
	tests := []struct{ in, want string }{
		{"1.2.3.4", "1.2.3.0"},
		{"203.0.113.255", "203.0.113.0"},
		{"2001:db8:abcd:1234:5678::1", "2001:db8:abcd::"},
		{"::1", "::"},
		{"::ffff:1.2.3.4", "1.2.3.0"},
		{"", ""},
		{"not-an-ip", ""},
	}
	for _, tt := range tests {
		if got := TruncateIP(tt.in); got != tt.want {
			t.Errorf("TruncateIP(%q) = %q want %q", tt.in, got, tt.want)
		}
	}
}

func TestApplySecurityHeaders(t *testing.T) {
	h := fsthttp.NewHeader()
	applySecurityHeaders(h, "/")
	for _, k := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy", "Cross-Origin-Opener-Policy"} {
		if h.Get(k) == "" {
			t.Errorf("missing %s", k)
		}
	}
	if h.Get("X-Robots-Tag") != "" {
		t.Error("public route must not carry X-Robots-Tag")
	}
	h = fsthttp.NewHeader()
	applySecurityHeaders(h, "/admin/login")
	if h.Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Errorf("admin X-Robots-Tag = %q", h.Get("X-Robots-Tag"))
	}
}

func TestIsAdminPath(t *testing.T) {
	for p, want := range map[string]bool{"/admin": true, "/admin/login": true, "/administrator": false, "/": false, "/post/admin": false} {
		if isAdminPath(p) != want {
			t.Errorf("isAdminPath(%q) != %v", p, want)
		}
	}
}
