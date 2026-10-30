//! Session tokens `v1.<expires>.<nonce>.<b64sig>` (contract §4).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_TTL_SECS: u64 = 3600;
const VERSION: &str = "v1";
const NONCE_HEX_LEN: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    InvalidToken,
    Expired,
    InvalidPassword,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidToken => write!(f, "invalid session token"),
            Self::Expired => write!(f, "session expired"),
            Self::InvalidPassword => write!(f, "invalid password"),
        }
    }
}

/// A token whose signature and expiry have been verified.
#[derive(Debug, PartialEq, Eq)]
pub struct Session {
    pub expires: u64,
    pub nonce: String,
}

fn sign(key: &[u8], payload: &str) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(payload.as_bytes());
    mac
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 16 random bytes as 32 lowercase hex chars.
pub fn new_nonce() -> Result<String, getrandom::Error> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf)?;
    Ok(hex(&buf))
}

pub fn create_session_token(key: &[u8], expires: u64, nonce: &str) -> String {
    let payload = format!("{VERSION}.{expires}.{nonce}");
    let sig = sign(key, &payload).finalize().into_bytes();
    format!("{payload}.{}", BASE64.encode(sig))
}

fn is_nonce(s: &str) -> bool {
    s.len() == NONCE_HEX_LEN && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Verify format, signature (constant-time) and expiry. Revocation is
/// checked separately by the caller because it needs the KV store.
pub fn verify_session_token(key: &[u8], token: &str, now: u64) -> Result<Session, AuthError> {
    let mut parts = token.split('.');
    let (Some(version), Some(expires), Some(nonce), Some(sig), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(AuthError::InvalidToken);
    };
    if version != VERSION || !is_nonce(nonce) || !expires.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AuthError::InvalidToken);
    }
    let sig_bytes = BASE64.decode(sig).map_err(|_| AuthError::InvalidToken)?;
    sign(key, &format!("{version}.{expires}.{nonce}"))
        .verify_slice(&sig_bytes)
        .map_err(|_| AuthError::InvalidToken)?;
    let expires: u64 = expires.parse().map_err(|_| AuthError::InvalidToken)?;
    if now > expires {
        return Err(AuthError::Expired);
    }
    Ok(Session {
        expires,
        nonce: nonce.to_string(),
    })
}

pub fn revocation_key(nonce: &str) -> String {
    format!("session-revoked:{nonce}")
}

pub fn verify_password(password: &str, hash: &str) -> Result<(), AuthError> {
    if bcrypt::verify(password, hash).unwrap_or(false) {
        Ok(())
    } else {
        Err(AuthError::InvalidPassword)
    }
}

pub fn extract_cookie(header: &str, name: &str) -> Option<String> {
    header.split(';').map(|s| s.trim()).find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?.trim();
        let value = parts.next()?.trim();
        if key == name {
            Some(value.to_string())
        } else {
            None
        }
    })
}

pub fn session_cookie(token: &str) -> String {
    format!("session={token}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age={SESSION_TTL_SECS}")
}

pub fn clear_session_cookie() -> String {
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"test-key";
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const NOW: u64 = 1_800_000_000;

    #[test]
    fn token_format() {
        let token = create_session_token(KEY, NOW + 3600, NONCE);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v1");
        assert_eq!(parts[1], (NOW + 3600).to_string());
        assert_eq!(parts[2], NONCE);
        assert_eq!(BASE64.decode(parts[3]).unwrap().len(), 32);
    }

    #[test]
    fn sign_and_verify() {
        let token = create_session_token(KEY, NOW + 3600, NONCE);
        assert_eq!(
            verify_session_token(KEY, &token, NOW),
            Ok(Session {
                expires: NOW + 3600,
                nonce: NONCE.to_string()
            })
        );
    }

    #[test]
    fn expired_rejected() {
        let token = create_session_token(KEY, NOW - 1, NONCE);
        assert_eq!(
            verify_session_token(KEY, &token, NOW),
            Err(AuthError::Expired)
        );
    }

    #[test]
    fn tampered_rejected() {
        let token = create_session_token(KEY, NOW + 3600, NONCE);
        let forged = token.replacen(&(NOW + 3600).to_string(), &(NOW + 99999).to_string(), 1);
        assert_eq!(
            verify_session_token(KEY, &forged, NOW),
            Err(AuthError::InvalidToken)
        );
        assert!(verify_session_token(KEY, &format!("{token}x"), NOW).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let token = create_session_token(b"key1", NOW + 3600, NONCE);
        assert!(verify_session_token(b"key2", &token, NOW).is_err());
    }

    #[test]
    fn legacy_two_part_token_rejected() {
        let expires = (NOW + 3600).to_string();
        let sig = BASE64.encode(sign(KEY, &expires).finalize().into_bytes());
        assert_eq!(
            verify_session_token(KEY, &format!("{expires}.{sig}"), NOW),
            Err(AuthError::InvalidToken)
        );
    }

    #[test]
    fn malformed_tokens_rejected() {
        let good = create_session_token(KEY, NOW + 3600, NONCE);
        let sig = good.rsplit('.').next().unwrap();
        for bad in [
            String::new(),
            format!("v2.{}.{NONCE}.{sig}", NOW + 3600),
            format!("v1.{}.{}.{sig}", NOW + 3600, "ABCDEF".repeat(6)),
            format!("v1.{}.short.{sig}", NOW + 3600),
            format!("v1.-5.{NONCE}.{sig}"),
            format!("{good}.extra"),
        ] {
            assert_eq!(
                verify_session_token(KEY, &bad, NOW),
                Err(AuthError::InvalidToken),
                "{bad}"
            );
        }
    }

    #[test]
    fn nonce_is_32_hex() {
        let n = new_nonce().unwrap();
        assert!(is_nonce(&n));
        assert_ne!(n, new_nonce().unwrap());
    }

    #[test]
    fn revocation_key_format() {
        assert_eq!(revocation_key(NONCE), format!("session-revoked:{NONCE}"));
    }

    #[test]
    fn parse_cookie() {
        let h = "session=abc; other=xyz";
        assert_eq!(extract_cookie(h, "session"), Some("abc".into()));
        assert_eq!(extract_cookie(h, "other"), Some("xyz".into()));
        assert_eq!(extract_cookie(h, "missing"), None);
    }

    #[test]
    fn cookie_attributes_unchanged() {
        assert_eq!(
            session_cookie("t"),
            "session=t; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600"
        );
    }
}
