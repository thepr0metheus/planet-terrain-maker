//! A file replaced whole: a reader sees the old one or the new one, never half.

use crate::random::Random;
use crate::store_error::StoreError;
use std::fs::{self, File};
use std::io::{self, Write as _};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// A write through a hidden file beside the target, then a rename. A killed process leaves at worst one such file.
pub struct AtomicFile;

impl AtomicFile {
    /// What is written to be read over ssh too: a model, the settings.
    pub const OPEN: u32 = 0o644;
    /// What only the server reads: a key, the picture sources, what it keeps of the services.
    pub const PRIVATE: u32 = 0o600;

    /// Replaces `path` with `body`, with this mode. The folder is made if it is missing. A failed write leaves the old
    /// file and no temporary one.
    pub fn write(path: &Path, body: &[u8], mode: u32) -> io::Result<()> {
        Self::replace(path, body, mode, false)
    }

    /// As `write`, for what must outlive a power cut: the bytes reach the disk before the rename, and the folder after it.
    pub fn write_synced(path: &Path, body: &[u8], mode: u32) -> io::Result<()> {
        Self::replace(path, body, mode, true)?;
        path.parent().map_or(Ok(()), Self::sync_folder)
    }

    /// Makes what was renamed in a folder last a power cut.
    pub fn sync_folder(folder: &Path) -> io::Result<()> {
        File::open(folder)?.sync_all()
    }

    /// The temporary file is made with its mode, and the mode is set again past the umask: a key is not readable by
    /// another user for a moment either.
    fn replace(path: &Path, body: &[u8], mode: u32, synced: bool) -> io::Result<()> {
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder)?;
        }
        let temporary = Self::temporary(path)?;
        let written = File::options()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)
            .and_then(|mut file| {
                file.write_all(body)?;
                if synced { file.sync_all() } else { Ok(()) }
            })
            .and_then(|()| fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)))
            .and_then(|()| fs::rename(&temporary, path));
        if written.is_err() {
            // The write's own failure is what the caller hears; a temporary file that was never made cannot be removed.
            drop(fs::remove_file(&temporary));
        }
        written
    }

    fn temporary(path: &Path) -> io::Result<PathBuf> {
        let random = Random::hex(6).map_err(|error: StoreError| io::Error::other(error.to_string()))?;
        Ok(path.with_file_name(format!(".part-{random}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("ptm-atomic-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&folder));
        folder
    }

    #[test]
    fn replaces_the_file_and_leaves_nothing_beside_it() {
        let root = folder("replaces");
        let path = root.join("deep").join("state.json");
        AtomicFile::write(&path, b"one", AtomicFile::OPEN).unwrap();
        AtomicFile::write_synced(&path, b"two", AtomicFile::PRIVATE).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_nothing_beside_it() {
        let root = folder("failed");
        let in_the_way = root.join("taken");
        fs::create_dir_all(in_the_way.join("inside")).unwrap();
        assert!(AtomicFile::write(&in_the_way, b"three", AtomicFile::OPEN).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1, "the temporary file went");
        fs::remove_dir_all(&root).unwrap();
    }
}
