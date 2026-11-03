//! Buildings of a region from OpenStreetMap, through the Overpass API. The server asks its servers in turn, takes the
//! first proper answer, and keeps it on disk.

use crate::fetcher::{Fetch, FetchError};
use files::{KeptFiles, Log, StoreError};
use rules::buildings::{BuildingsAnswer, BuildingsQuestion};
use rules::{Clock, JsonForm, Refused, Region};
use serde_json::Value;
use std::fmt;
use std::path::Path;
use std::sync::Arc;

/// Why there are no buildings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildingsError {
    /// The region is too big: the words say so.
    Refused(String),
    /// No Overpass server gave a proper answer.
    Unavailable(String),
    /// The disk where answers are kept.
    Store(StoreError),
}

impl From<StoreError> for BuildingsError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// Why one server did not do.
enum MirrorFailed {
    Fetch(FetchError),
    Answer(String),
}

impl fmt::Display for MirrorFailed {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fetch(error) => write!(out, "{error}"),
            Self::Answer(words) => out.write_str(words),
        }
    }
}

impl From<FetchError> for MirrorFailed {
    fn from(error: FetchError) -> Self {
        Self::Fetch(error)
    }
}

impl From<Refused> for MirrorFailed {
    fn from(refused: Refused) -> Self {
        Self::Answer(refused.0)
    }
}

/// The service, and what was kept of it.
pub struct Overpass {
    fetcher: Arc<dyn Fetch>,
    kept: KeptFiles,
    clock: Arc<dyn Clock>,
    log: Log,
}

impl Overpass {
    const SECONDS: u64 = 60;
    const FORM: &'static str = "application/x-www-form-urlencoded";

    /// The service, with its answers kept in this store.
    pub fn new(fetcher: Arc<dyn Fetch>, kept: KeptFiles, clock: Arc<dyn Clock>, log: Log) -> Self {
        Self { fetcher, kept, clock, log }
    }

    /// `{buildings, cut, credit}` of the region.
    pub fn buildings(&self, region: &Region) -> Result<Value, BuildingsError> {
        let question = BuildingsQuestion::of(region).map_err(|refused| BuildingsError::Refused(refused.0))?;
        if let Some(known) = self.remembered(&question.file_name)? {
            return Ok(known);
        }
        let mut failures = Vec::new();
        for mirror in BuildingsQuestion::MIRRORS {
            match self.asked_of(mirror, &question.form) {
                Ok(found) => {
                    self.kept.keep(Path::new(&question.file_name), JsonForm::ASCII_COMPACT.write(&found).as_bytes());
                    return Ok(found);
                }
                Err(failure) => failures.push(format!("{}: {failure}", Self::host_of(mirror))),
            }
        }
        let words = format!("No Overpass server answered: {}", failures.join("; "));
        self.log.say(&format!("buildings: {words}"));
        Err(BuildingsError::Unavailable(words))
    }

    fn remembered(&self, name: &str) -> Result<Option<Value>, StoreError> {
        let kept = self.kept.read_fresher_than(Path::new(name), self.clock.now(), BuildingsQuestion::KEEP_SECONDS)?;
        Ok(kept.and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    fn asked_of(&self, mirror: &str, form: &str) -> Result<Value, MirrorFailed> {
        let answer = self.fetcher.post(mirror, form.as_bytes(), &[("Content-Type", Self::FORM)], Self::SECONDS)?;
        let data: Value =
            serde_json::from_slice(&answer.body).map_err(|error| MirrorFailed::Answer(format!("no JSON: {error}")))?;
        Ok(BuildingsAnswer::read(&data)?)
    }

    fn host_of(mirror: &str) -> &str {
        let after = mirror.strip_prefix("https://").unwrap_or(mirror);
        after.split('/').next().unwrap_or(after)
    }
}
