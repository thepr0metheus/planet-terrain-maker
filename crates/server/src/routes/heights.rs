//! Heights and imagery of a region.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use rules::Grid;
use rules::planets::Planet;
use services::{CopernicusError, HeightsError, PlanetError};

/// The addresses of heights.
pub struct HeightRoutes;

impl HeightRoutes {
    fn grid_answer(grid: &Grid) -> Answer {
        grid.fields()
            .into_iter()
            .fold(Answer::bytes(200, "application/octet-stream", grid.to_bytes()), |answer, (name, value)| {
                answer.field(name, value)
            })
    }

    fn note_grid(asked: &Exchange<'_>, what: &str, grid: &Grid) {
        asked.app.log.say(&format!("{what} heights {}x{} from {}", grid.cols(), grid.rows(), grid.source()));
    }

    /// `GET /api/earth/heights`.
    pub fn earth(asked: &mut Exchange<'_>) -> Handled {
        let region = asked.region()?;
        let outside = &asked.app.outside;
        if asked.asked("source") == Some("aws") {
            let cells = asked.cells()?;
            return match outside.copernicus_aws.grid(region, cells) {
                Ok(grid) => {
                    Self::note_grid(asked, "earth", &grid);
                    Ok(Self::grid_answer(&grid))
                }
                Err(CopernicusError::Failed(words)) => {
                    asked.app.log.say(&format!("earth heights (aws): {words}"));
                    Err(Failure::refused(502, format!("Copernicus on AWS: {words}")))
                }
                Err(CopernicusError::Store(error)) => Err(error.into()),
            };
        }
        match outside.open_topography.grid(&region, asked.cells()?) {
            Ok(grid) => {
                Self::note_grid(asked, "earth", &grid);
                Ok(Self::grid_answer(&grid))
            }
            Err(HeightsError::KeyNeeded(words)) => {
                Err(Failure::Refusal { status: 403, payload: serde_json::json!({"error": words, "key_needed": true}) })
            }
            Err(HeightsError::SourceFailed(words)) => {
                asked.app.log.say(&format!("earth heights: {words}"));
                Err(Failure::refused(502, words))
            }
            Err(HeightsError::Store(error)) => Err(error.into()),
        }
    }

    fn planet_asked(asked: &Exchange<'_>) -> Result<&'static Planet, Failure> {
        // absent-ok: no world asked is no world there is, and the refusal says which there are.
        Planet::named(asked.asked("world").unwrap_or_default())
            .ok_or_else(|| Failure::refused(400, format!("world must be one of: {}", Planet::names())))
    }

    /// `GET /api/planet/heights`.
    pub fn planet(asked: &mut Exchange<'_>) -> Handled {
        let planet = Self::planet_asked(asked)?;
        let region = asked.region()?;
        let source = asked.asked("source");
        if !matches!(source, None | Some("trek")) {
            return Err(Failure::refused(400, "source must be trek, or left out"));
        }
        match asked.app.outside.trek.heights(planet, region, asked.cells()?, source.is_none()) {
            Ok(grid) => {
                Self::note_grid(asked, planet.body, &grid);
                Ok(Self::grid_answer(&grid))
            }
            Err(PlanetError::Refused(words)) => Err(Failure::refused(400, words)),
            Err(PlanetError::Failed(words)) => {
                asked.app.log.say(&format!("{} heights: {words}", planet.body));
                Err(Failure::refused(502, words))
            }
        }
    }

    /// `GET /api/planet/image`.
    pub fn planet_image(asked: &mut Exchange<'_>) -> Handled {
        let planet = Self::planet_asked(asked)?;
        let region = asked.region()?;
        match asked.app.outside.trek.image(planet, &region, asked.picture_size()?) {
            Ok(body) => Ok(Answer::bytes(200, "image/jpeg", body)),
            Err(PlanetError::Refused(words)) => Err(Failure::refused(400, words)),
            Err(PlanetError::Failed(words)) => {
                asked.app.log.say(&format!("{} image: {words}", planet.body));
                Err(Failure::refused(502, words))
            }
        }
    }
}
