//! Map tiles, and shapes of asteroids, comets and spacecraft.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use rules::shapes::ShapeList;
use services::{ShapeError, TileError};

/// The addresses of what is fetched once and kept.
pub struct MapRoutes;

impl MapRoutes {
    /// `GET /api/tile/<source>/<z>/<x>/<y>`.
    pub fn tile(asked: &mut Exchange<'_>) -> Handled {
        let tiles = &asked.app.outside.tiles;
        let name = asked.param("source");
        let (z, x, y) = (asked.whole("z"), asked.whole("x"), asked.whole("y"));
        let (Some(layer), Some(z), Some(x), Some(y)) = (tiles.source(name), z, x, y) else {
            return Err(Failure::refused(404, "no such tile"));
        };
        if !layer.has(z, x, y) {
            return Err(Failure::refused(404, "no such tile"));
        }
        match tiles.get(layer, z, x, y) {
            Ok(tile) => {
                Ok(Answer::bytes(200, Answer::kind_of(&tile.content_type), tile.body).cached(Answer::KEPT_LONG))
            }
            Err(TileError::Missing) => Err(Failure::refused(404, "the layer has no such tile")),
            Err(TileError::Failed(error)) => {
                asked.app.log.say(&format!("tile {name} {z}/{x}/{y}: {error}"));
                Err(Failure::refused(502, format!("{name}: {error}")))
            }
            Err(TileError::Store(error)) => Err(error.into()),
        }
    }

    /// A shape from its list; it does not change, so it is kept long.
    fn shape(asked: &Exchange<'_>, got: Result<(Vec<u8>, &'static str), ShapeError>, what: &str) -> Handled {
        match got {
            Ok((body, kind)) => Ok(Answer::bytes(200, Answer::kind_of(kind), body).cached(Answer::KEPT_LONG)),
            Err(ShapeError::Unknown(words)) => Err(Failure::refused(404, words)),
            Err(ShapeError::Failed(words)) => {
                asked.app.log.say(&format!("shape {what}: {words}"));
                Err(Failure::refused(502, format!("{what}: {words}")))
            }
            Err(ShapeError::Store(error)) => Err(error.into()),
        }
    }

    fn listed(asked: &Exchange<'_>, list: ShapeList, name: &str) -> Handled {
        let id = asked.param(name);
        Self::shape(asked, asked.app.outside.shapes.listed(list, id), id)
    }

    /// `GET /api/asteroids/top/<asteroid_id>`.
    pub fn asteroid_top(asked: &mut Exchange<'_>) -> Handled {
        Self::listed(asked, ShapeList::Top, "asteroid_id")
    }

    /// `GET /api/asteroids/damit/<model_id>`.
    pub fn asteroid_damit(asked: &mut Exchange<'_>) -> Handled {
        let said = asked.param("model_id");
        let got = asked.app.outside.shapes.damit(said, asked.whole("model_id"));
        Self::shape(asked, got, &format!("DAMIT {said}"))
    }

    /// `GET /api/comets/<comet_id>`.
    pub fn comet(asked: &mut Exchange<'_>) -> Handled {
        Self::listed(asked, ShapeList::Comets, "comet_id")
    }

    /// `GET /api/vehicles/<vehicle_id>`.
    pub fn vehicle(asked: &mut Exchange<'_>) -> Handled {
        Self::listed(asked, ShapeList::Vehicles, "vehicle_id")
    }
}
