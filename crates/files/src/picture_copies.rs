//! Smaller copies of a model's pictures, made once and kept in `data/cache/pictures`. The page on a touch device asks for
//! a picture at most 4096 a side (`GET .../files/<name>?most=4096`).

use crate::kept_files::KeptFiles;
use crate::store_error::StoreError;
use pictures::SmallerCopy;
use std::fs;
use std::path::{Path, PathBuf};

/// What answers a request for a picture at most so big.
#[derive(Debug, PartialEq, Eq)]
pub enum SmallerPicture {
    /// A file to serve: the picture itself, or its copy.
    File(PathBuf),
    /// The copy's JPEG, when it could not be kept.
    Bytes(Vec<u8>),
}

/// Why there is no answer.
#[derive(Debug, PartialEq, Eq)]
pub enum CopyError {
    /// The size asked is out of range: the words say so.
    OutOfRange(String),
    /// A file that is not a readable JPEG or PNG: the words say which.
    NotAPicture(String),
    /// The disk.
    Store(StoreError),
}

impl From<StoreError> for CopyError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// The copies.
pub struct PictureCopies {
    files: KeptFiles,
}

impl PictureCopies {
    const LEAST: i64 = 64;
    const MOST: i64 = 16384;

    /// The copies in this store.
    pub fn new(files: KeptFiles) -> Self {
        Self { files }
    }

    /// The picture at `path`, or a copy of it at most `most` points a side when it is bigger. `key` names the copy in
    /// the store (the model's id and the file's name).
    pub fn at_most(&self, path: &Path, most: i64, key: &str) -> Result<SmallerPicture, CopyError> {
        if !(Self::LEAST..=Self::MOST).contains(&most) {
            return Err(CopyError::OutOfRange(format!("most must lie within {}..{}", Self::LEAST, Self::MOST)));
        }
        let name = format!("{key}-{most}.jpg");
        let copy = self.files.root().join(&name);
        if Self::is_fresh(&copy, path)? {
            return Ok(SmallerPicture::File(copy));
        }
        let bytes = fs::read(path).map_err(StoreError::from)?;
        let not_a_picture = |_| {
            // absent-ok: a path with no name has none to say.
            let file = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
            CopyError::NotAPicture(format!("{file} is not a readable JPEG or PNG picture"))
        };
        let Some(body) = SmallerCopy::of(&bytes, most as usize).map_err(not_a_picture)? else {
            return Ok(SmallerPicture::File(path.to_path_buf()));
        };
        Ok(if self.files.keep(Path::new(&name), &body) {
            SmallerPicture::File(copy)
        } else {
            SmallerPicture::Bytes(body)
        })
    }

    /// Whether the copy is there, made from this very file.
    fn is_fresh(copy: &Path, picture: &Path) -> Result<bool, StoreError> {
        let Ok(kept) = fs::metadata(copy) else {
            return Ok(false);
        };
        Ok(kept.is_file() && kept.modified()? >= fs::metadata(picture)?.modified()?)
    }
}
