//! Detailed picture tiles uploaded by browsers: their addresses and what they may be. The server never fetches a
//! source's address: keys identify saved sources, and requests and file names hold no address or query key.

use crate::refused::Refused;

/// Where a detailed tile lies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailAddress {
    /// The source's key, as its folder.
    pub key: String,
    /// The zoom.
    pub z: u64,
    /// The column.
    pub x: u64,
    /// The row.
    pub y: u64,
}

impl DetailAddress {
    /// The most a tile may weigh.
    pub const MOST_BYTES: usize = 1024 * 1024;
    /// The side of a tile.
    pub const SIDE: u32 = 256;
    const MOST_ZOOM: u64 = 22;

    /// The address, refused when it cannot be: a number too big for its place comes as `None`.
    pub fn checked(key: &str, z: Option<u64>, x: Option<u64>, y: Option<u64>) -> Result<Self, Refused> {
        let is_key = key.len() == 64 && key.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        match (is_key, z, x, y) {
            (true, Some(z), Some(x), Some(y)) if z <= Self::MOST_ZOOM && x < 1 << z && y < 1 << z => {
                Ok(Self { key: key.to_string(), z, x, y })
            }
            _ => Err(Refused::new("Invalid detail tile address.")),
        }
    }

    /// The type of content a tile's bytes say.
    pub fn content_type(body: &[u8]) -> Result<&'static str, Refused> {
        if body.starts_with(b"\xff\xd8") {
            Ok("image/jpeg")
        } else if body.starts_with(b"\x89PNG\r\n\x1a\n") {
            Ok("image/png")
        } else {
            Err(Refused::new("Detail tiles must be PNG or JPEG images."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        let key = "a".repeat(64);
        assert!(DetailAddress::checked(&key, Some(19), Some(322903), Some(195236)).is_ok());
        assert!(DetailAddress::checked(&key, Some(22), Some(0), Some(0)).is_ok());
        for (key, z, x, y) in [
            ("nothex".to_string(), Some(1), Some(0), Some(0)),
            ("A".repeat(64), Some(1), Some(0), Some(0)),
            (key.clone(), Some(23), Some(0), Some(0)),
            (key.clone(), Some(1), Some(2), Some(0)),
            (key.clone(), Some(1), Some(0), Some(2)),
            (key.clone(), None, Some(0), Some(0)),
            (key, Some(1), None, Some(0)),
        ] {
            assert!(DetailAddress::checked(&key, z, x, y).is_err(), "{key} {z:?} {x:?} {y:?}");
        }
    }

    #[test]
    fn kinds() {
        assert_eq!(DetailAddress::content_type(b"\xff\xd8\xff").unwrap(), "image/jpeg");
        assert_eq!(DetailAddress::content_type(b"\x89PNG\r\n\x1a\n").unwrap(), "image/png");
        assert!(DetailAddress::content_type(b"GIF89a").is_err());
    }
}
