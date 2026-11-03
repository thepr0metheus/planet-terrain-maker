//! Names of places on Earth, and buildings.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use services::BuildingsError;

/// The addresses of what is on Earth.
pub struct PlaceRoutes;

impl PlaceRoutes {
    /// `GET /api/search`.
    pub fn search(asked: &mut Exchange<'_>) -> Handled {
        // absent-ok: nothing asked is nothing to look for.
        let query = asked.asked("q").unwrap_or_default();
        let language = asked.asked("lang").unwrap_or("en");
        match asked.app.outside.nominatim.search(query, language) {
            Ok(found) => Ok(Answer::json(200, &found)),
            Err(error) => {
                asked.app.log.say(&format!("search: {}", error.0));
                Err(Failure::refused(502, error.0))
            }
        }
    }

    /// `GET /api/place`.
    pub fn place(asked: &mut Exchange<'_>) -> Handled {
        let lat = asked.number("lat", Some(-90.0), Some(90.0))?;
        let lon = asked.number("lon", Some(-180.0), Some(180.0))?;
        let language = asked.asked("lang").unwrap_or("en");
        match asked.app.outside.nominatim.reverse(lat, lon, language) {
            Ok(found) => Ok(Answer::json(200, &found)),
            Err(error) => {
                asked.app.log.say(&format!("place: {}", error.0));
                Err(Failure::refused(502, error.0))
            }
        }
    }

    /// `GET /api/buildings`.
    pub fn buildings(asked: &mut Exchange<'_>) -> Handled {
        let region = asked.region()?;
        match asked.app.outside.overpass.buildings(&region) {
            Ok(found) => Ok(Answer::json(200, &found)),
            Err(BuildingsError::Refused(words)) => Err(Failure::refused(400, words)),
            Err(BuildingsError::Unavailable(words)) => Err(Failure::refused(502, words)),
            Err(BuildingsError::Store(error)) => Err(error.into()),
        }
    }
}
