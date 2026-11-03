//! A lock whose owner may fail.

use std::sync::{Mutex, PoisonError};

/// State behind a lock, that a panic in another request does not put out of use: a thread that died mid-way left the files
/// as whole as `AtomicFile` keeps them, and the state is read on, not given up for lost.
#[derive(Debug, Default)]
pub struct Locked<T> {
    state: Mutex<T>,
}

impl<T> Locked<T> {
    /// `value` behind a lock.
    pub const fn new(value: T) -> Self {
        Self { state: Mutex::new(value) }
    }

    /// Does `work` with the state held.
    pub fn with<R>(&self, work: impl FnOnce(&mut T) -> R) -> R {
        work(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }
}
