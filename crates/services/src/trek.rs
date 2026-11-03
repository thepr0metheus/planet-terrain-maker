//! Heights and imagery from NASA's Trek services, and the Moon's finer heights from the USGS file.

use crate::fetcher::{Fetch, FetchError};
use files::Log;
use rules::planets::Planet;
use rules::sldem::SldemPlan;
use rules::{Grid, Refused, Region};
use std::fmt;
use std::sync::Arc;
use std::thread;

/// Why there are no heights or no picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanetError {
    /// What was asked cannot be: the words say why.
    Refused(String),
    /// Trek failed, or has nothing there: the words say which.
    Failed(String),
}

impl From<FetchError> for PlanetError {
    fn from(error: FetchError) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<Refused> for PlanetError {
    fn from(refused: Refused) -> Self {
        Self::Failed(refused.0)
    }
}

/// Why the finer file gave no heights: Trek answers then.
#[derive(Debug)]
struct FinerFailed(String);

impl fmt::Display for FinerFailed {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

/// The rows a worker read: each with its number.
type RowsRead = Vec<(i64, Vec<f64>)>;

/// The services.
pub struct Trek {
    fetcher: Arc<dyn Fetch>,
    log: Log,
}

impl Trek {
    const SECONDS: u64 = 90;
    const SECONDS_A_ROW: u64 = 60;

    /// The services, asked through this.
    pub fn new(fetcher: Arc<dyn Fetch>, log: Log) -> Self {
        Self { fetcher, log }
    }

    /// The heights of the region: from the finer source when it covers the region and `finest` says so (falling back to
    /// Trek if it fails), else from Trek.
    pub fn heights(
        &self,
        planet: &Planet,
        region: Region,
        max_cells: usize,
        finest: bool,
    ) -> Result<Grid, PlanetError> {
        if finest && planet.has_finer_heights && SldemPlan::covers(&region) {
            match self.finer(SldemPlan::of(region, max_cells)) {
                Ok(grid) => return Ok(grid),
                Err(error) => {
                    self.log.say(&format!("{} heights: SLDEM2015 failed, Trek's LOLA instead: {error}", planet.body));
                }
            }
        }
        let size = planet.heights_size(&region, max_cells);
        let answer = self.fetcher.get(&planet.heights_url(&region, size), &[], Self::SECONDS)?;
        let values = planet.parse_heights(&answer.body, size)?;
        if values.iter().all(|value| value.is_nan()) {
            return Err(PlanetError::Failed(format!("Trek has no heights of {} in this region", planet.body)));
        }
        Ok(Grid::new(size.0, size.1, values, region, planet.heights_name)?)
    }

    /// A JPEG of exactly the region, north up.
    pub fn image(&self, planet: &Planet, region: &Region, size: (usize, usize)) -> Result<Vec<u8>, PlanetError> {
        let url = planet.image_url(region, size).map_err(|refused| PlanetError::Refused(refused.0))?;
        let answer = self.fetcher.get(&url, &[], Self::SECONDS)?;
        if !answer.content_type.starts_with("image/") {
            let said = if answer.content_type.is_empty() { "no type" } else { &answer.content_type };
            return Err(PlanetError::Failed(format!("Trek sent no picture ({said})")));
        }
        Ok(answer.body)
    }

    /// The rows of the file, read by `THREADS` workers: one failed row fails the region.
    fn finer(&self, plan: SldemPlan) -> Result<Grid, FinerFailed> {
        let rows = plan.file_rows();
        let workers = SldemPlan::THREADS.min(rows.len());
        let read: Vec<Result<RowsRead, FinerFailed>> = thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|worker| {
                    let (rows, plan) = (&rows, &plan);
                    scope.spawn(move || {
                        rows.iter().skip(worker).step_by(SldemPlan::THREADS).map(|row| self.row(plan, *row)).collect()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or_else(|_| Err(FinerFailed("a worker failed".to_string()))))
                .collect()
        });
        let mut all = Vec::with_capacity(rows.len());
        for part in read {
            all.extend(part?);
        }
        all.sort_by_key(|(row, _)| *row);
        let block: Vec<f64> = all.into_iter().flat_map(|(_, heights)| heights).collect();
        plan.grid(&block).map_err(|refused| FinerFailed(refused.0))
    }

    fn row(&self, plan: &SldemPlan, row: i64) -> Result<(i64, Vec<f64>), FinerFailed> {
        let range = plan.range_of(row);
        let answer = self
            .fetcher
            .get(SldemPlan::URL, &[("Range", &range)], Self::SECONDS_A_ROW)
            .map_err(|error| FinerFailed(error.to_string()))?;
        if answer.status != 206 {
            return Err(FinerFailed(format!("row {row}: HTTP {}", answer.status)));
        }
        let heights = plan.read_row(&answer.body).map_err(|refused| FinerFailed(format!("row {row}: {refused}")))?;
        Ok((row, heights))
    }
}
