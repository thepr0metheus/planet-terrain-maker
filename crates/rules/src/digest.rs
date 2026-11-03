//! Hashes, as hex.

use ring::digest::{self, Algorithm, SHA1_FOR_LEGACY_USE_ONLY, SHA256};
use std::fmt::Write as _;

/// The hashes the app names things by. Neither guards anything: SHA-1 only names a kept answer, as it always did,
/// so that the files already kept are found.
pub struct Digest;

impl Digest {
    /// SHA-256, as 64 hex digits: the key of a picture source.
    pub fn sha256_hex(bytes: &[u8]) -> String {
        Self::hex_of(&SHA256, bytes)
    }

    /// SHA-1, as 40 hex digits.
    pub fn sha1_hex(bytes: &[u8]) -> String {
        Self::hex_of(&SHA1_FOR_LEGACY_USE_ONLY, bytes)
    }

    /// Bytes as hex digits.
    pub fn hex(bytes: &[u8]) -> String {
        bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            // absent-ok: writing to a String does not fail.
            write!(out, "{byte:02x}").unwrap_or_default();
            out
        })
    }

    fn hex_of(algorithm: &'static Algorithm, bytes: &[u8]) -> String {
        Self::hex(digest::digest(algorithm, bytes).as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hashes_of_a_known_text() {
        assert_eq!(Digest::sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(Digest::sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(Digest::hex(&[0, 255]), "00ff");
    }
}
