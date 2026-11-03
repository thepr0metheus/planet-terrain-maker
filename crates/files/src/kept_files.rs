//! Files kept of what a service sent. A store that cannot be written (the data folder without the right to write, a full
//! disk) costs the keeping, not the answer: it is said once in the log, and the answer goes out all the same.

use crate::atomic::AtomicFile;
use crate::locked::Locked;
use crate::log::Log;
use crate::store_error::StoreError;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A folder of kept files.
pub struct KeptFiles {
    root: PathBuf,
    subject: &'static str,
    log: Log,
    said: Locked<bool>,
}

impl KeptFiles {
    /// A store under this folder. `subject` starts what the log says when it cannot be written: `shapes: shapes are`.
    pub fn new(root: PathBuf, subject: &'static str, log: Log) -> Self {
        Self { root, subject, log, said: Locked::new(false) }
    }

    /// The folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// What lies at this path under the folder; `None` when nothing does.
    pub fn read(&self, relative: &Path) -> Result<Option<Vec<u8>>, StoreError> {
        match fs::read(self.root.join(relative)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// What lies at this path, when it was written less than `seconds` before `now`.
    pub fn read_fresher_than(&self, relative: &Path, now: f64, seconds: f64) -> Result<Option<Vec<u8>>, StoreError> {
        let written = match fs::metadata(self.root.join(relative)) {
            Ok(meta) => meta.modified()?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        // absent-ok: a file dated before 1970 reads as very old, which is what it is.
        let written = written.duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64());
        if now - written < seconds { self.read(relative) } else { Ok(None) }
    }

    /// Keeps these bytes, and says whether they were kept.
    pub fn keep(&self, relative: &Path, body: &[u8]) -> bool {
        match AtomicFile::write(&self.root.join(relative), body, AtomicFile::PRIVATE) {
            Ok(()) => {
                self.said.with(|said| *said = false);
                true
            }
            Err(error) => {
                self.say_once(&error);
                false
            }
        }
    }

    fn say_once(&self, error: &io::Error) {
        let first = self.said.with(|said| !std::mem::replace(said, true));
        if first {
            self.log.say(&format!("{} not kept, {} cannot be written: {error}", self.subject, self.root.display()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::StillClock;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    fn kept(name: &str) -> KeptFiles {
        let root = std::env::temp_dir().join(format!("ptm-kept-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        KeptFiles::new(root, "tests: files are", Log::new(Arc::new(StillClock::at(0.0))))
    }

    #[test]
    fn what_is_kept_is_read_and_what_is_not_is_none() {
        let files = kept("read");
        assert_eq!(files.read(Path::new("a/b.bin")).unwrap(), None);
        assert!(files.keep(Path::new("a/b.bin"), b"x"));
        assert_eq!(files.read(Path::new("a/b.bin")).unwrap().unwrap(), b"x");
        fs::remove_dir_all(files.root()).unwrap();
    }

    #[test]
    fn a_store_that_cannot_be_written_costs_only_the_keeping() {
        let files = kept("locked");
        fs::create_dir_all(files.root()).unwrap();
        fs::set_permissions(files.root(), fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(files.root().join("probe"), b"").is_ok() {
            // Root writes where the test forbids it: there is nothing to see here.
            fs::remove_dir_all(files.root()).unwrap();
            return;
        }
        assert!(!files.keep(Path::new("a.bin"), b"x"));
        assert!(!files.keep(Path::new("b.bin"), b"x"));
        assert!(files.said.with(|said| *said));
        fs::set_permissions(files.root(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(files.keep(Path::new("a.bin"), b"x"), "the right given back, it keeps again");
        assert!(!files.said.with(|said| *said), "and a new outage will be said again");
        fs::remove_dir_all(files.root()).unwrap();
    }
}
