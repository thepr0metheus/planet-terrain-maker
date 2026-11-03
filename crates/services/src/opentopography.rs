//! Heights of a region on Earth from Copernicus DEM, through OpenTopography's API (a key is needed).

use crate::fetcher::Fetch;
use files::{KeyStore, StoreError};
use rules::ascii_grid::AsciiGrid;
use rules::opentopo::OpenTopoRequest;
use rules::{Grid, Letters, Region};
use std::sync::Arc;

/// Why there are no heights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeightsError {
    /// There is no key, or OpenTopography refused it (wrong, or out of its daily quota).
    KeyNeeded(String),
    /// OpenTopography did not send a grid.
    SourceFailed(String),
    /// The disk, where the key lies.
    Store(StoreError),
}

impl From<StoreError> for HeightsError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// The service.
pub struct OpenTopography {
    fetcher: Arc<dyn Fetch>,
    keys: Arc<KeyStore>,
}

impl OpenTopography {
    const SECONDS: u64 = 120;
    const WORDS_OF_A_REFUSED_KEY: [&'static str; 4] = ["api_key", "api key", "invalid key", "unauthorized"];

    /// The service, with its key in this store.
    pub fn new(fetcher: Arc<dyn Fetch>, keys: Arc<KeyStore>) -> Self {
        Self { fetcher, keys }
    }

    /// The heights of a region, at most `max_cells` a side.
    pub fn grid(&self, region: &Region, max_cells: usize) -> Result<Grid, HeightsError> {
        let Some(key) = self.keys.get()? else {
            return Err(HeightsError::KeyNeeded("Copernicus heights need an OpenTopography key.".to_string()));
        };
        let answer = match self.fetcher.get(&OpenTopoRequest::url(region, &key), &[], Self::SECONDS) {
            Ok(answer) => answer,
            Err(error) if matches!(error.status, Some(401 | 403)) => {
                return Err(HeightsError::KeyNeeded("OpenTopography refused the key.".to_string()));
            }
            Err(error) if error.status == Some(429) => {
                let words = "OpenTopography says the key has used up its requests for today.";
                return Err(HeightsError::KeyNeeded(words.to_string()));
            }
            Err(error) => {
                return Err(HeightsError::SourceFailed(self.keys.scrub(&format!("OpenTopography: {error}"))?));
            }
        };
        let text = String::from_utf8_lossy(&answer.body);
        if !Letters::head(&text, 200).to_lowercase().contains("ncols") {
            return Err(self.no_grid(&text)?);
        }
        let name = OpenTopoRequest::model(region).1;
        AsciiGrid::parse(&text, name).map(|grid| grid.reduced(max_cells)).map_err(|refused| {
            HeightsError::SourceFailed(format!("OpenTopography sent a grid that cannot be read: {refused}"))
        })
    }

    /// What is said of an answer with no grid in it. What a service says back may quote the request, the key too.
    fn no_grid(&self, text: &str) -> Result<HeightsError, StoreError> {
        let scrubbed = self.keys.scrub(Letters::strip(text))?;
        let said = Letters::head(&scrubbed, 300);
        let small = said.to_lowercase();
        Ok(if Self::WORDS_OF_A_REFUSED_KEY.iter().any(|word| small.contains(word)) {
            HeightsError::KeyNeeded(format!("OpenTopography refused the key: {said}"))
        } else {
            let said = if said.is_empty() { "an empty answer" } else { said };
            HeightsError::SourceFailed(format!("OpenTopography sent no heights here: {said}"))
        })
    }
}
