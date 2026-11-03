//! Random bytes.

use crate::store_error::StoreError;
use ring::rand::{SecureRandom, SystemRandom};
use rules::Digest;

/// What the system's generator gives.
pub struct Random;

impl Random {
    /// `count` bytes as hex digits.
    pub fn hex(count: usize) -> Result<String, StoreError> {
        let mut bytes = vec![0; count];
        SystemRandom::new().fill(&mut bytes).map_err(|_| StoreError::failed("the system gave no random bytes"))?;
        Ok(Digest::hex(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_draws_differ_and_have_their_size() {
        let (one, other) = (Random::hex(6).unwrap(), Random::hex(6).unwrap());
        assert_eq!(one.len(), 12);
        assert_ne!(one, other);
    }
}
