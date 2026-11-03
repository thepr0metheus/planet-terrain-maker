//! The OpenTopography key: the one secret the app has. It is given once on the page; the server keeps it (mode 600) and
//! uses it for every device. The page can set it, replace it and remove it, and asks only whether there is one: the key
//! itself never goes back out. Without a file the server takes `OPENTOPO_KEY` from its environment, if there is one.

use crate::atomic::AtomicFile;
use crate::store_error::StoreError;
use rules::Letters;
use rules::Refused;
use rules::opentopo::OpenTopoKey;
use std::fs;
use std::io;
use std::path::PathBuf;

/// The key.
pub struct KeyStore {
    path: PathBuf,
    fallback: Option<String>,
}

impl KeyStore {
    /// The key at this path, and the one of the environment for when there is none.
    pub fn new(path: PathBuf, fallback: Option<String>) -> Self {
        Self { path, fallback: fallback.filter(|key| !key.is_empty()) }
    }

    fn of_the_page(&self) -> Result<Option<String>, StoreError> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                Ok(Some(Letters::strip(&text).to_string()).filter(|key| !key.is_empty()))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// The key in use.
    pub fn get(&self) -> Result<Option<String>, StoreError> {
        Ok(self.of_the_page()?.or_else(|| self.fallback.clone()))
    }

    /// Where the key in use comes from: `page`, `environment`, or none.
    pub fn source(&self) -> Result<Option<&'static str>, StoreError> {
        Ok(if self.of_the_page()?.is_some() { Some("page") } else { self.fallback.as_ref().map(|_| "environment") })
    }

    /// Keeps a key the page gave; `Ok(Err)` when it is no key.
    pub fn set(&self, key: &str) -> Result<Result<(), Refused>, StoreError> {
        match OpenTopoKey::checked(key) {
            Ok(key) => {
                AtomicFile::write(&self.path, key.as_bytes(), AtomicFile::PRIVATE)?;
                Ok(Ok(()))
            }
            Err(refused) => Ok(Err(refused)),
        }
    }

    /// Removes the key the page gave, if there is one.
    pub fn clear(&self) -> Result<(), StoreError> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// `text` without the key in it: what a service says back may quote the request.
    pub fn scrub(&self, text: &str) -> Result<String, StoreError> {
        Ok(match self.get()? {
            Some(key) => text.replace(&key, "[key]"),
            None => text.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn store(name: &str, fallback: Option<&str>) -> KeyStore {
        let root = std::env::temp_dir().join(format!("ptm-key-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        KeyStore::new(root.join("keys").join("opentopo"), fallback.map(str::to_string))
    }

    #[test]
    fn the_page_gives_a_key_and_it_is_kept_private() {
        let keys = store("page", None);
        assert_eq!(keys.source().unwrap(), None);
        assert_eq!(keys.get().unwrap(), None);
        keys.set(&format!("  {KEY}\n")).unwrap().unwrap();
        assert_eq!(fs::read_to_string(&keys.path).unwrap(), KEY);
        assert_eq!(fs::metadata(&keys.path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(keys.source().unwrap(), Some("page"));
        assert_eq!(keys.scrub(&format!("busy, see {KEY}")).unwrap(), "busy, see [key]");
        assert!(keys.set("short").unwrap().is_err());
        assert_eq!(keys.get().unwrap().as_deref(), Some(KEY), "a wrong key changes nothing");
        keys.clear().unwrap();
        keys.clear().unwrap();
        assert_eq!(keys.get().unwrap(), None);
    }

    #[test]
    fn the_page_s_key_comes_before_the_environment_s() {
        let keys = store("environment", Some("from-the-environment"));
        assert_eq!(keys.source().unwrap(), Some("environment"));
        keys.set(KEY).unwrap().unwrap();
        assert_eq!(keys.source().unwrap(), Some("page"));
        assert_eq!(keys.get().unwrap().as_deref(), Some(KEY));
        keys.clear().unwrap();
        assert_eq!(keys.get().unwrap().as_deref(), Some("from-the-environment"));
        assert_eq!(store("empty", Some("")).source().unwrap(), None);
    }
}
