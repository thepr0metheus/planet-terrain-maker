//! The page, and what says what this copy is.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use crate::file_answer::FileAnswer;
use crate::openapi::ApiDescription;
use crate::route_table::ROUTES;
use serde_json::{Value, json};

/// The page's addresses.
pub struct PageRoutes;

impl PageRoutes {
    /// `GET /`.
    pub fn index(asked: &mut Exchange<'_>) -> Handled {
        Self::file_named(asked, "index.html")
    }

    /// `GET /<path:path>`.
    pub fn file(asked: &mut Exchange<'_>) -> Handled {
        let path = asked.param("path").to_string();
        Self::file_named(asked, &path)
    }

    fn file_named(asked: &mut Exchange<'_>, path: &str) -> Handled {
        match FileAnswer::under(&asked.app.web, path) {
            Some(file) => FileAnswer::of(&file, asked.head.headers.get("If-None-Match").as_deref()),
            None => Ok(Answer::page_of(404)),
        }
    }

    /// `GET /healthz`.
    pub fn health(asked: &mut Exchange<'_>) -> Handled {
        Ok(Answer::json(200, &json!({"status": "ok", "version": asked.app.version})))
    }

    /// `GET /openapi.json`.
    pub fn description(asked: &mut Exchange<'_>) -> Handled {
        Ok(Answer::json(200, &ApiDescription::build(&ROUTES, asked.app.version.as_deref())))
    }

    /// `GET /api/packages`.
    pub fn packages(asked: &mut Exchange<'_>) -> Handled {
        let listing = asked.app.packages.listing()?;
        let Value::Object(fields) = listing else {
            return Err(Failure::Internal("the list of packages is no table".to_string()));
        };
        let mut payload = json!({"version": asked.app.version});
        if let Some(whole) = payload.as_object_mut() {
            whole.extend(fields);
        }
        Ok(Answer::json(200, &payload))
    }
}
