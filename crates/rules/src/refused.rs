//! A value that cannot be.

use std::fmt;

/// A value that cannot be, and the words that say why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

impl Refused {
    /// A refusal in these words.
    pub fn new(words: impl Into<String>) -> Self {
        Self(words.into())
    }
}

impl fmt::Display for Refused {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}
