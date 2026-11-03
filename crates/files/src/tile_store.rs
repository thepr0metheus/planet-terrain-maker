//! Map tiles on the server's disk: a tile kept is not asked for again, for tiles of a place do not change. At most about
//! `max_bytes` of them: past that the tiles not served for longest go first.

use crate::kept_files::KeptFiles;
use crate::store_error::StoreError;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A tile of a layer: where it lies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileAddress<'a> {
    /// The layer's name.
    pub layer: &'a str,
    /// The ending of the layer's files.
    pub extension: &'a str,
    /// The zoom.
    pub z: u64,
    /// The column.
    pub x: u64,
    /// The row.
    pub y: u64,
}

impl TileAddress<'_> {
    fn folder(&self) -> PathBuf {
        Path::new(self.layer).join(self.z.to_string()).join(self.x.to_string())
    }

    fn tile(&self) -> PathBuf {
        self.folder().join(format!("{}.{}", self.y, self.extension))
    }

    fn missing(&self) -> PathBuf {
        self.folder().join(format!("{}.missing", self.y))
    }
}

/// The tiles kept, and those the service does not have.
pub struct TileStore {
    files: KeptFiles,
    max_bytes: u64,
}

impl TileStore {
    /// A tile the service does not have is remembered this long, so that a map zoomed past its data does not ask again
    /// on every move.
    const MISSING_SECONDS: f64 = 24.0 * 3600.0;
    /// What is left after a trim, of `max_bytes`.
    const LEFT_AFTER_TRIM: f64 = 0.9;

    /// A store of at most about `max_bytes`.
    pub fn new(files: KeptFiles, max_bytes: u64) -> Self {
        Self { files, max_bytes }
    }

    /// The tile, if it is kept. Served `now`: the last to go when the store is trimmed.
    pub fn read(&self, address: &TileAddress<'_>, now: f64) -> Result<Option<Vec<u8>>, StoreError> {
        let relative = address.tile();
        let found = self.files.read(&relative)?;
        if found.is_some() {
            // A tile that cannot be marked as served only goes sooner.
            drop(Self::touch(&self.files.root().join(relative), now));
        }
        Ok(found)
    }

    fn touch(path: &Path, now: f64) -> io::Result<()> {
        File::options().write(true).open(path)?.set_modified(UNIX_EPOCH + Duration::from_secs_f64(now.max(0.0)))
    }

    /// Keeps a tile, and says whether it was kept.
    pub fn keep(&self, address: &TileAddress<'_>, body: &[u8]) -> bool {
        self.files.keep(&address.tile(), body)
    }

    /// Whether the service was found lately not to have this tile.
    pub fn is_missing(&self, address: &TileAddress<'_>, now: f64) -> Result<bool, StoreError> {
        match fs::metadata(self.files.root().join(address.missing())) {
            Ok(meta) => Ok(now - Self::seconds_of(meta.modified()?) < Self::MISSING_SECONDS),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Remembers that the service does not have this tile.
    pub fn remember_missing(&self, address: &TileAddress<'_>) {
        self.files.keep(&address.missing(), b"");
    }

    fn seconds_of(moment: SystemTime) -> f64 {
        // absent-ok: a file dated before 1970 reads as very old, which is what it is.
        moment.duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64())
    }

    /// Removes the tiles served longest ago until the store is under 90% of `max_bytes`, if it is past them. Says how many
    /// files went.
    pub fn trim(&self) -> io::Result<usize> {
        let mut found = Vec::new();
        Self::walk(self.files.root(), &mut found)?;
        let mut total: u64 = found.iter().map(|(_, size, _)| size).sum();
        if total <= self.max_bytes {
            return Ok(0);
        }
        found.sort_by(|one, other| one.partial_cmp(other).unwrap_or(std::cmp::Ordering::Equal));
        let mut removed = 0;
        for (_, size, path) in found {
            if total as f64 <= self.max_bytes as f64 * Self::LEFT_AFTER_TRIM {
                break;
            }
            if let Err(error) = fs::remove_file(&path)
                && error.kind() != io::ErrorKind::NotFound
            {
                return Err(error);
            }
            total -= size;
            removed += 1;
        }
        Ok(removed)
    }

    /// Every file under `folder`: when it was served, its size, its path. A file that goes while this walks was served
    /// and replaced, or trimmed.
    fn walk(folder: &Path, found: &mut Vec<(f64, u64, PathBuf)>) -> io::Result<()> {
        let entries = match fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if meta.is_dir() {
                Self::walk(&entry.path(), found)?;
            } else if meta.is_file() {
                found.push((Self::seconds_of(meta.modified()?), meta.len(), entry.path()));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::Log;
    use rules::StillClock;
    use std::sync::Arc;

    fn store(name: &str, max_bytes: u64) -> TileStore {
        let root = std::env::temp_dir().join(format!("ptm-tiles-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        TileStore::new(
            KeptFiles::new(root, "tile store: tiles are", Log::new(Arc::new(StillClock::at(0.0)))),
            max_bytes,
        )
    }

    fn at(x: u64) -> TileAddress<'static> {
        TileAddress { layer: "earth-heights", extension: "png", z: 5, x, y: 0 }
    }

    fn date(store: &TileStore, address: &TileAddress<'_>, seconds: u64) {
        File::options()
            .write(true)
            .open(store.files.root().join(address.tile()))
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }

    #[test]
    fn trim_takes_the_tiles_served_longest_ago() {
        let tiles = store("trim", 250);
        for x in 0..4 {
            tiles.keep(&at(x), &[b'x'; 100]);
            date(&tiles, &at(x), 1000 + x);
        }
        assert_eq!(tiles.trim().unwrap(), 2);
        assert_eq!(tiles.read(&at(0), 5000.0).unwrap(), None);
        assert_eq!(tiles.read(&at(1), 5000.0).unwrap(), None);
        assert!(tiles.read(&at(3), 5000.0).unwrap().is_some());
        fs::remove_dir_all(tiles.files.root()).unwrap();
    }

    #[test]
    fn a_store_within_its_size_is_left_alone() {
        let tiles = store("within", 1000);
        tiles.keep(&at(0), &[b'x'; 100]);
        assert_eq!(tiles.trim().unwrap(), 0);
        fs::remove_dir_all(tiles.files.root()).unwrap();
    }

    #[test]
    fn a_store_that_is_not_there_has_nothing_to_trim() {
        assert_eq!(store("absent", 10).trim().unwrap(), 0);
    }

    #[test]
    fn a_tile_served_is_the_last_to_go() {
        let tiles = store("served", 1000);
        tiles.keep(&at(0), b"x");
        date(&tiles, &at(0), 1000);
        tiles.read(&at(0), 5000.0).unwrap();
        let path = tiles.files.root().join(at(0).tile());
        assert_eq!(TileStore::seconds_of(fs::metadata(path).unwrap().modified().unwrap()), 5000.0);
        fs::remove_dir_all(tiles.files.root()).unwrap();
    }

    #[test]
    fn a_missing_tile_is_remembered_for_a_day() {
        let tiles = store("missing", 1000);
        assert!(!tiles.is_missing(&at(0), 1e9).unwrap());
        tiles.remember_missing(&at(0));
        let written =
            TileStore::seconds_of(fs::metadata(tiles.files.root().join(at(0).missing())).unwrap().modified().unwrap());
        assert!(tiles.is_missing(&at(0), written + 3600.0).unwrap());
        assert!(!tiles.is_missing(&at(0), written + 2.0 * 86400.0).unwrap());
        fs::remove_dir_all(tiles.files.root()).unwrap();
    }
}
