//! What can go wrong on the disk.

use std::fmt;
use std::io;

/// Why the disk did not do what was asked. The two are answered differently: a folder the app may not write is a thing
/// to tell the person who runs it, and the rest is a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The system refused: the app has no right to this file or folder.
    Denied(String),
    /// Anything else.
    Failed(String),
}

impl StoreError {
    /// A failure in these words.
    pub fn failed(words: impl Into<String>) -> Self {
        Self::Failed(words.into())
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::PermissionDenied {
            Self::Denied(error.to_string())
        } else {
            Self::Failed(error.to_string())
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied(words) | Self::Failed(words) => out.write_str(words),
        }
    }
}
