use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
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

pub fn create_session_token(key: &[u8], ttl_seconds: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let expires = (now as i64 + ttl_seconds) as u64;
    let payload = expires.to_string();
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes();
    format!("{}.{}", payload, BASE64.encode(sig))
}

pub fn verify_session_token(key: &[u8], token: &str) -> Result<(), AuthError> {
    let parts: Vec<&str> = token.splitn(2, '.').collect();
    if parts.len() != 2 {
        return Err(AuthError::InvalidToken);
    }
    let sig_bytes = BASE64
        .decode(parts[1])
        .map_err(|_| AuthError::InvalidToken)?;
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(parts[0].as_bytes());
    mac.verify_slice(&sig_bytes)
        .map_err(|_| AuthError::InvalidToken)?;
    let expires: u64 = parts[0].parse().map_err(|_| AuthError::InvalidToken)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    if now > expires {
        return Err(AuthError::Expired);
    }
    Ok(())
}

pub fn verify_password(password: &str, hash: &str) -> Result<(), AuthError> {
    if bcrypt::verify(password, hash).unwrap_or(false) {
        Ok(())
    } else {
        Err(AuthError::InvalidPassword)
    }
}

pub fn extract_cookie(header: &str, name: &str) -> Option<String> {
    header
        .split(';')
        .map(|s| s.trim())
        .find_map(|pair| {
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
    format!(
        "session={}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600",
        token
    )
}

pub fn clear_session_cookie() -> String {
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify() {
        let key = b"test-key";
        let token = create_session_token(key, 3600);
        assert!(verify_session_token(key, &token).is_ok());
    }

    #[test]
    fn expired_rejected() {
        let token = create_session_token(b"key", -1);
        assert!(verify_session_token(b"key", &token).is_err());
    }

    #[test]
    fn tampered_rejected() {
        let token = format!("{}x", create_session_token(b"key", 3600));
        assert!(verify_session_token(b"key", &token).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let token = create_session_token(b"key1", 3600);
        assert!(verify_session_token(b"key2", &token).is_err());
    }

    #[test]
    fn parse_cookie() {
        let h = "session=abc; other=xyz";
        assert_eq!(extract_cookie(h, "session"), Some("abc".into()));
        assert_eq!(extract_cookie(h, "other"), Some("xyz".into()));
        assert_eq!(extract_cookie(h, "missing"), None);
    }
}
