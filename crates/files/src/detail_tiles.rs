//! Detailed picture tiles uploaded by browsers, kept in the data folder for reopening models. Every uploaded tile is checked
//! before it is stored.

use crate::atomic::AtomicFile;
use pictures::{PictureHead, PictureKind, Rgb};
use rules::detail_tile::DetailAddress;
use std::fs;
use std::io;
use std::path::PathBuf;

/// Why a tile was not kept or read.
#[derive(Debug, PartialEq, Eq)]
pub enum DetailError {
    /// An invalid tile: the words say why.
    Invalid(String),
    /// The disk.
    Disk,
}

/// The tiles, under `data/picture-tiles`.
pub struct DetailTiles {
    root: PathBuf,
}

impl DetailTiles {
    /// The tiles under this folder.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_of(&self, address: &DetailAddress) -> PathBuf {
        self.root
            .join(&address.key)
            .join(address.z.to_string())
            .join(address.x.to_string())
            .join(format!("{}.tile", address.y))
    }

    /// The tile and its type of content; `None` when it was not uploaded yet.
    pub fn read(&self, address: &DetailAddress) -> Result<Option<(Vec<u8>, &'static str)>, DetailError> {
        let body = match fs::read(self.path_of(address)) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(DetailError::Disk),
        };
        let kind = DetailAddress::content_type(&body).map_err(|refused| DetailError::Invalid(refused.0))?;
        Ok(Some((body, kind)))
    }

    /// Checks a tile, and keeps it.
    pub fn keep(&self, address: &DetailAddress, body: &[u8]) -> Result<(), DetailError> {
        Self::check(body)?;
        AtomicFile::write(&self.path_of(address), body, AtomicFile::PRIVATE).map_err(|_| DetailError::Disk)
    }

    fn check(body: &[u8]) -> Result<(), DetailError> {
        let invalid = |words: &str| Err(DetailError::Invalid(words.to_string()));
        if body.is_empty() || body.len() > DetailAddress::MOST_BYTES {
            return invalid("The detail tile is too large.");
        }
        DetailAddress::content_type(body).map_err(|refused| DetailError::Invalid(refused.0))?;
        let not_readable = |_| DetailError::Invalid("The detail tile is not a readable image.".to_string());
        let head = PictureHead::read(body).map_err(not_readable)?;
        let side = DetailAddress::SIDE as usize;
        if (head.width, head.height) != (side, side) {
            return invalid("Detail tiles must be 256 by 256 pixels.");
        }
        // As it always was: a PNG is read to its end, a JPEG as far as its head says what it is.
        if head.kind == PictureKind::Png {
            Rgb::read(body, &head).map_err(not_readable)?;
        }
        Ok(())
    }
}
