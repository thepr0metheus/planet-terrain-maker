//! Picture sources people enter, and the detailed tiles browsers upload.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use files::{DetailError, SourceError};
use rules::detail_tile::DetailAddress;
use serde_json::Value;
use wire::ContentLength;

/// The addresses of the picture sources.
pub struct SourceRoutes;

impl SourceRoutes {
    const NOT_READ: &'static str = "The detail tile could not be read.";
    const NOT_SAVED: &'static str = "The detail tile could not be saved.";

    fn address_asked(asked: &Exchange<'_>) -> Result<DetailAddress, Failure> {
        DetailAddress::checked(asked.param("key"), asked.whole("z"), asked.whole("x"), asked.whole("y"))
            .map_err(|refused| Failure::refused(400, refused.0))
    }

    /// `GET /api/picture-sources/<key>/tiles/<z>/<x>/<y>`.
    pub fn tile_get(asked: &mut Exchange<'_>) -> Handled {
        let address = Self::address_asked(asked)?;
        match asked.app.stores.detail_tiles.read(&address) {
            Ok(Some((body, kind))) => {
                Ok(Answer::bytes(200, kind, body).field("Cache-Control", "private, max-age=86400"))
            }
            Ok(None) => Err(Failure::refused(404, "Detail tile not downloaded yet.")),
            Err(DetailError::Invalid(words)) => Err(Failure::refused(400, words)),
            Err(DetailError::Disk) => Err(Failure::refused(503, Self::NOT_READ)),
        }
    }

    /// `PUT /api/picture-sources/<key>/tiles/<z>/<x>/<y>`.
    pub fn tile_put(asked: &mut Exchange<'_>) -> Handled {
        let stores = &asked.app.stores;
        let known = stores.picture_sources.has_key(asked.param("key"));
        match known {
            Ok(true) => {}
            Ok(false) => return Err(Failure::refused(404, "Unknown picture source.")),
            Err(_) => return Err(Failure::refused(503, Self::NOT_SAVED)),
        }
        let too_large = || Failure::refused(400, "The detail tile is too large.");
        if matches!(asked.head.headers.content_length(), ContentLength::Bytes(size) if size > DetailAddress::MOST_BYTES)
        {
            return Err(too_large());
        }
        let body = asked.read_body(DetailAddress::MOST_BYTES)?;
        let address = Self::address_asked(asked)?;
        match stores.detail_tiles.keep(&address, &body) {
            Ok(()) => Ok(Answer::empty(204)),
            Err(DetailError::Invalid(words)) => Err(Failure::refused(400, words)),
            Err(DetailError::Disk) => Err(Failure::refused(503, Self::NOT_SAVED)),
        }
    }

    fn list_answer(answer: Result<Vec<Value>, SourceError>) -> Handled {
        match answer {
            Ok(entries) => Ok(Answer::json(200, &Value::Array(entries))),
            Err(SourceError::Invalid(words)) => Err(Failure::refused(400, words)),
            Err(SourceError::Store(words)) => Err(Failure::refused(503, words)),
        }
    }

    /// `GET /api/picture-sources`.
    pub fn list(asked: &mut Exchange<'_>) -> Handled {
        Ok(Self::list_answer(asked.app.stores.picture_sources.list())?.field("Cache-Control", "no-store"))
    }

    /// `POST /api/picture-sources`.
    pub fn keep(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_value()?;
        Self::list_answer(asked.app.stores.picture_sources.keep(data.as_ref()))
    }

    /// `DELETE /api/picture-sources`.
    pub fn forget(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_value()?;
        let url = data.as_ref().and_then(|data| data.get("url"));
        Self::list_answer(asked.app.stores.picture_sources.forget(url))
    }
}
