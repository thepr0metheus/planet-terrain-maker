//! The server's log.

use rules::{Clock, Stamp};
use std::io::{self, Write as _};
use std::sync::Arc;

/// Lines on the standard output, each with its moment: what the container's log holds.
#[derive(Clone)]
pub struct Log {
    clock: Arc<dyn Clock>,
}

impl Log {
    /// A log that tells the time by this clock.
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock }
    }

    /// One line, or more when the words hold line ends.
    pub fn say(&self, words: &str) {
        let line = format!("{} {words}\n", Stamp::plain(self.clock.now()));
        // A log that cannot be written has nowhere to say so.
        drop(io::stdout().lock().write_all(line.as_bytes()));
    }
}
