//! Shape files of asteroids, comets and spacecraft: the server fetches a file from where it lives the first time, keeps it
//! in `data/cache/asteroids`, and gives it from there afterwards. A shape does not change.

use crate::fetcher::{Fetch, FetchError};
use files::{KeptFiles, StoreError};
use rules::shapes::{DamitShape, ListedShapes, ShapeKind, ShapeList};
use rules::{PyText, Refused};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

/// Why there is no shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShapeError {
    /// No such shape in the lists: the words say which.
    Unknown(String),
    /// Where it lives did not give it, or gave something else: the words say which.
    Failed(String),
    /// The disk.
    Store(StoreError),
}

impl From<FetchError> for ShapeError {
    fn from(error: FetchError) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<Refused> for ShapeError {
    fn from(refused: Refused) -> Self {
        Self::Failed(refused.0)
    }
}

impl From<StoreError> for ShapeError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// The lists, and the files kept.
pub struct ShapeFiles {
    fetcher: Arc<dyn Fetch>,
    kept: KeptFiles,
    lists: HashMap<ShapeList, ListedShapes>,
}

impl ShapeFiles {
    const SECONDS: u64 = 120;

    /// The files kept in this store, by the lists in this folder of the page; refused when a list cannot be read: the
    /// lists are the app's own.
    pub fn new(fetcher: Arc<dyn Fetch>, kept: KeptFiles, lists_folder: &Path) -> Result<Self, String> {
        let mut lists = HashMap::new();
        for list in ShapeList::ALL {
            let path = lists_folder.join(list.file_name());
            let cannot_read = |why: String| format!("{}: {why}", path.display());
            let bytes = fs::read(&path).map_err(|error| cannot_read(error.to_string()))?;
            let value = serde_json::from_slice(&bytes).map_err(|error| cannot_read(error.to_string()))?;
            let shapes = ListedShapes::read(&value).map_err(|refused| cannot_read(refused.0))?;
            lists.insert(list, shapes);
        }
        Ok(Self { fetcher, kept, lists })
    }

    /// A shape of one of the lists, by its id: the file, and its type of content.
    pub fn listed(&self, list: ShapeList, id: &str) -> Result<(Vec<u8>, &'static str), ShapeError> {
        let shape = self.lists.get(&list).and_then(|shapes| shapes.get(id));
        let Some(shape) = shape else {
            return Err(ShapeError::Unknown(format!("no shape called {} in the list", PyText::repr(id))));
        };
        let name = format!("{}-{id}.{}", list.prefix(), shape.kind.extension);
        Ok((self.kept(&name, &shape.url, &shape.kind)?, shape.kind.content_type))
    }

    /// A shape of the DAMIT catalogue, by its model's number, as the address said it: vertices and facets.
    pub fn damit(&self, said: &str, model: Option<u64>) -> Result<(Vec<u8>, &'static str), ShapeError> {
        let found = model.and_then(|model| DamitShape::url(model).map(|url| (model, url)));
        let (Some((model, url)), Some(kind)) = (found, ShapeKind::of_damit()) else {
            return Err(ShapeError::Unknown(format!("no DAMIT model {said}")));
        };
        Ok((self.kept(&format!("damit-{model}.obj"), &url, &kind)?, kind.content_type))
    }

    fn kept(&self, name: &str, url: &str, kind: &ShapeKind) -> Result<Vec<u8>, ShapeError> {
        if let Some(body) = self.kept.read(Path::new(name))? {
            return Ok(body);
        }
        let body = self.fetcher.get(url, &[], Self::SECONDS)?.body;
        kind.check(&body)?;
        self.kept.keep(Path::new(name), &body);
        Ok(body)
    }
}
