//! User-entered picture sources in the data folder, never in the source checkout. Addresses may hold a viewer's query
//! key: they are stored as data only, not logged or fetched here.

use crate::atomic::AtomicFile;
use crate::json_file::JsonRead;
use crate::locked::Locked;
use rules::JsonForm;
use rules::picture_source::PictureSource;
use serde_json::Value;
use std::path::PathBuf;

/// Why a source was not kept or read.
#[derive(Debug, PartialEq, Eq)]
pub enum SourceError {
    /// It cannot be used as a source: the words say why.
    Invalid(String),
    /// The saved list could not be read or written: the words say which. A list that cannot be read is reported and not
    /// overwritten.
    Store(String),
}

/// The list of sources, newest first; the same address stands once.
pub struct PictureSources {
    path: PathBuf,
    writing: Locked<()>,
}

impl PictureSources {
    const NOT_READ: &'static str = "The saved picture sources could not be read.";
    const NOT_SAVED: &'static str = "The picture sources could not be saved.";

    /// The list at this path.
    pub fn new(path: PathBuf) -> Self {
        Self { path, writing: Locked::new(()) }
    }

    fn read(&self) -> Result<Vec<Value>, SourceError> {
        let not_read = || SourceError::Store(Self::NOT_READ.to_string());
        match JsonRead::of(&self.path).map_err(|_| not_read())? {
            JsonRead::Absent => Ok(Vec::new()),
            JsonRead::Broken => Err(not_read()),
            JsonRead::Value(list) => PictureSource::read_list(&list).map_err(|_| not_read()),
        }
    }

    fn write(&self, entries: Vec<Value>) -> Result<Vec<Value>, SourceError> {
        let text = JsonForm::FILE.write(&Value::Array(entries.clone()));
        AtomicFile::write_synced(&self.path, text.as_bytes(), AtomicFile::PRIVATE)
            .map_err(|_| SourceError::Store(Self::NOT_SAVED.to_string()))?;
        Ok(entries)
    }

    /// The sources.
    pub fn list(&self) -> Result<Vec<Value>, SourceError> {
        self.writing.with(|()| self.read())
    }

    /// Whether a source of this key is saved.
    pub fn has_key(&self, key: &str) -> Result<bool, SourceError> {
        Ok(self.list()?.iter().any(|source| source.get("key").and_then(Value::as_str) == Some(key)))
    }

    /// Remembers a source, and gives the list as it is now.
    pub fn keep(&self, data: Option<&Value>) -> Result<Vec<Value>, SourceError> {
        let source = PictureSource::checked(data).map_err(|refused| SourceError::Invalid(refused.0))?;
        self.writing.with(|()| {
            let others = self.read()?.into_iter().filter(|entry| entry.get("url") != source.get("url"));
            let entries = std::iter::once(source.clone()).chain(others).collect();
            self.write(entries)
        })
    }

    /// Forgets one address, and gives the list as it is now.
    pub fn forget(&self, url: Option<&Value>) -> Result<Vec<Value>, SourceError> {
        let url = PictureSource::address(url).map_err(|refused| SourceError::Invalid(refused.0))?;
        self.writing.with(|()| {
            let entries =
                self.read()?.into_iter().filter(|entry| entry.get("url").and_then(Value::as_str) != Some(url.as_str()));
            let entries = entries.collect();
            self.write(entries)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn sources(name: &str) -> PictureSources {
        let root = std::env::temp_dir().join(format!("ptm-sources-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        fs::create_dir_all(&root).unwrap();
        PictureSources::new(root.join("picture-sources.json"))
    }

    const A: &str = "https://tiles.example.org/photo/{z}/{x}/{y}.png";
    const B: &str = "https://tiles.example.org/topo/{z}/{x}/{y}.png";

    #[test]
    fn newest_first_and_each_address_once() {
        let store = sources("order");
        assert_eq!(store.list().unwrap(), Vec::<Value>::new());
        store.keep(Some(&json!({"url": A}))).unwrap();
        store.keep(Some(&json!({"url": B}))).unwrap();
        let entries = store.keep(Some(&json!({"url": A, "name": "Photo"}))).unwrap();
        assert_eq!(entries.iter().map(|entry| entry["url"].as_str().unwrap()).collect::<Vec<_>>(), [A, B]);
        assert_eq!(entries[0]["name"], "Photo");
        let left = store.forget(Some(&json!(A))).unwrap();
        assert_eq!(left.iter().map(|entry| entry["url"].as_str().unwrap()).collect::<Vec<_>>(), [B]);
        assert!(store.has_key(left[0]["key"].as_str().unwrap()).unwrap());
        assert!(!store.has_key("nothing").unwrap());
    }

    #[test]
    fn a_list_that_cannot_be_read_is_reported_and_not_overwritten() {
        let store = sources("corrupt");
        for corrupt in ["{broken", "{\"not\": \"a list\"}", "[{\"url\": \"http://x/{z}/{x}/{y}\"}]", "[5]"] {
            fs::write(&store.path, corrupt).unwrap();
            assert!(matches!(store.list(), Err(SourceError::Store(_))), "{corrupt}");
            assert!(matches!(store.keep(Some(&json!({"url": A}))), Err(SourceError::Store(_))), "{corrupt}");
            assert_eq!(fs::read_to_string(&store.path).unwrap(), corrupt);
        }
    }

    #[test]
    fn what_cannot_be_used_makes_no_file() {
        let store = sources("invalid");
        assert!(matches!(store.keep(Some(&json!({"url": "invalid"}))), Err(SourceError::Invalid(_))));
        assert!(matches!(store.forget(None), Err(SourceError::Invalid(_))));
        assert!(!store.path.exists());
    }
}
