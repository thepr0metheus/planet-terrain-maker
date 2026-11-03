//! What a route answers instead of an answer.

use files::StoreError;
use serde_json::{Value, json};

/// A request that went no further.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// Refused, in words the page can read.
    Refusal {
        /// The status.
        status: u16,
        /// The JSON of the answer.
        payload: Value,
    },
    /// A page of this status: the request itself could not be taken. The connection goes.
    Page(u16),
    /// The disk.
    Store(StoreError),
    /// Something that should not be: its words go to the log.
    Internal(String),
}

impl Failure {
    /// Refused, with this status and these words.
    pub fn refused(status: u16, words: impl Into<String>) -> Self {
        Self::Refusal { status, payload: json!({"error": words.into()}) }
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
