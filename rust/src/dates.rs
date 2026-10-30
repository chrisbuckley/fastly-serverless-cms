//! Time helpers shared by handlers, feeds and sessions.

use std::time::{SystemTime, UNIX_EPOCH};

use time::format_description::well_known::{Rfc2822, Rfc3339};
use time::OffsetDateTime;

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whole-second UTC ISO 8601 timestamp, e.g. `2026-05-20T14:30:00Z`.
pub fn iso8601_from_unix(secs: u64) -> String {
    OffsetDateTime::from_unix_timestamp(secs as i64)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

pub fn now_iso8601() -> String {
    iso8601_from_unix(unix_now())
}

/// RFC-822 date for RSS (`Mon, 02 Jan 2006 15:04:05 +0000`) from an ISO 8601 timestamp.
pub fn rfc822(iso: &str) -> Option<String> {
    OffsetDateTime::parse(iso, &Rfc3339)
        .ok()?
        .to_offset(time::UtcOffset::UTC)
        .format(&Rfc2822)
        .ok()
}

pub fn rfc822_from_unix(secs: u64) -> String {
    rfc822(&iso8601_from_unix(secs)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formatting() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1779287400), "2026-05-20T14:30:00Z");
    }

    #[test]
    fn rfc822_formatting() {
        assert_eq!(
            rfc822("2006-01-02T15:04:05Z").as_deref(),
            Some("Mon, 02 Jan 2006 15:04:05 +0000")
        );
        assert_eq!(
            rfc822("2026-05-20T16:30:00+02:00").as_deref(),
            Some("Wed, 20 May 2026 14:30:00 +0000")
        );
        assert_eq!(rfc822("not a date"), None);
        assert_eq!(rfc822_from_unix(0), "Thu, 01 Jan 1970 00:00:00 +0000");
    }
}
