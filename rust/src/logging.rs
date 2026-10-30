//! Structured request logging (contract §12). Never log secrets, cookies or bodies.

use std::io::Write;
use std::net::IpAddr;

use fastly::log::Endpoint;
use serde_json::json;

const ENDPOINT: &str = "edge-cms-app-logs";

/// IPv4 → /24, IPv6 → /48.
pub fn truncate_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            format!("{a}.{b}.{c}.0")
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            std::net::Ipv6Addr::new(s[0], s[1], s[2], 0, 0, 0, 0, 0).to_string()
        }
    }
}

/// At most `max` bytes of `s`, cut on a char boundary.
pub fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub struct RequestLog<'a> {
    pub level: &'a str,
    pub msg: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub status: u16,
    pub duration_ms: u128,
    pub client_ip: Option<IpAddr>,
}

pub fn format_line(ts: &str, entry: &RequestLog) -> String {
    json!({
        "ts": ts,
        "level": entry.level,
        "msg": entry.msg,
        "method": entry.method,
        "path": entry.path,
        "status": entry.status,
        "duration_ms": entry.duration_ms,
        "client_ip": entry.client_ip.map(truncate_ip),
    })
    .to_string()
}

fn emit(line: &str) {
    let written = Endpoint::try_from_name(ENDPOINT)
        .ok()
        .is_some_and(|mut ep| writeln!(ep, "{line}").is_ok());
    if !written {
        eprintln!("{line}");
    }
}

pub fn request(entry: &RequestLog) {
    emit(&format_line(&crate::dates::now_iso8601(), entry));
}

/// Operational message without request context (e.g. purge or upstream failures).
pub fn event(level: &str, msg: &str) {
    emit(
        &json!({
            "ts": crate::dates::now_iso8601(),
            "level": level,
            "msg": msg,
        })
        .to_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_ipv4() {
        assert_eq!(truncate_ip("1.2.3.4".parse().unwrap()), "1.2.3.0");
    }

    #[test]
    fn truncates_ipv6() {
        assert_eq!(
            truncate_ip("2001:db8:abcd:12:1:2:3:4".parse().unwrap()),
            "2001:db8:abcd::"
        );
    }

    #[test]
    fn truncate_bytes_respects_char_boundary() {
        assert_eq!(truncate_bytes("abc", 200), "abc");
        assert_eq!(truncate_bytes("ééé", 3), "é");
        assert_eq!(truncate_bytes(&"x".repeat(300), 200).len(), 200);
    }

    #[test]
    fn line_has_contract_fields() {
        let line = format_line(
            "2026-01-01T00:00:00Z",
            &RequestLog {
                level: "info",
                msg: "request",
                method: "GET",
                path: "/",
                status: 200,
                duration_ms: 3,
                client_ip: Some("9.8.7.6".parse().unwrap()),
            },
        );
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        for k in [
            "ts",
            "level",
            "msg",
            "method",
            "path",
            "status",
            "duration_ms",
            "client_ip",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["client_ip"], "9.8.7.0");
    }
}
