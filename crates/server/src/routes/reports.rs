//! The page's own errors, and the cache of one device.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use files::ClientErrors;
use rules::Whole;
use serde_json::json;

/// The addresses of the page's reports.
pub struct ReportRoutes;

impl ReportRoutes {
    const LAST: i64 = 50;

    /// `GET /api/client-errors`.
    pub fn kept(asked: &mut Exchange<'_>) -> Handled {
        let last = match asked.asked("last") {
            None => Self::LAST,
            Some(said) => Whole::read(said).ok_or_else(|| Failure::refused(400, "last must be a number"))?,
        };
        let last = last.clamp(1, ClientErrors::KEEP as i64) as usize;
        Ok(Answer::json(200, &json!({"errors": asked.app.stores.client_errors.recent(last)?})))
    }

    /// `POST /api/client-error`.
    pub fn take(asked: &mut Exchange<'_>) -> Handled {
        let report = asked.json_object()?;
        Ok(Answer::empty(if asked.app.stores.client_errors.take(&report) { 204 } else { 429 }))
    }

    /// `POST /api/clear-cache`.
    pub fn clear_cache(_: &mut Exchange<'_>) -> Handled {
        Ok(Answer::empty(204).field("Clear-Site-Data", "\"cache\""))
    }
}
