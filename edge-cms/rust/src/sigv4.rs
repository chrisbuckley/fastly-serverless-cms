use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex_encode(&hasher.finalize())
}

fn hmac_sha256_raw(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn derive_signing_key(secret_key: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256_raw(format!("AWS4{}", secret_key).as_bytes(), date.as_bytes());
    let k_region = hmac_sha256_raw(&k_date, region.as_bytes());
    let k_service = hmac_sha256_raw(&k_region, service.as_bytes());
    hmac_sha256_raw(&k_service, b"aws4_request")
}

pub fn sign(signing_key: &[u8], string_to_sign: &str) -> String {
    hex_encode(&hmac_sha256_raw(signing_key, string_to_sign.as_bytes()))
}

/// Returns (datetime, date) as e.g. ("20260521T134000Z", "20260521")
pub fn utc_datetime() -> (String, String) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let days = secs / 86400;
    let tod = secs % 86400;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    let (y, mo, d) = days_to_ymd(days);
    let datetime = format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", y, mo, d, h, m, s);
    let date = datetime[..8].to_string();
    (datetime, date)
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
