//! The saved models.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use crate::file_answer::FileAnswer;
use files::{CopyError, LibraryError, SmallerPicture};
use rules::{PyText, Whole};
use serde_json::{Value, json};
use std::path::Path;

/// The addresses of the models.
pub struct ModelRoutes;

impl ModelRoutes {
    fn failed(error: LibraryError) -> Failure {
        match error {
            LibraryError::NotFound => Failure::refused(404, "no such model"),
            LibraryError::Refused(words) => Failure::refused(400, words),
            LibraryError::Store(error) => error.into(),
        }
    }

    /// `GET /api/models`.
    pub fn list(asked: &mut Exchange<'_>) -> Handled {
        Ok(Answer::json(200, &Value::Array(asked.app.stores.library.list()?)))
    }

    /// `POST /api/models`.
    pub fn create(asked: &mut Exchange<'_>) -> Handled {
        let (body, boundary) = asked.upload_bytes()?;
        let upload = Exchange::upload(&body, boundary.as_deref())?;
        let saved = asked.app.stores.library.create(&upload.meta, &upload.files).map_err(Self::failed)?;
        let files = saved.get("files").and_then(Value::as_object);
        // absent-ok: a model just saved has its files, and the log only counts them.
        let total: u64 = files.map_or(0, |files| files.values().filter_map(Value::as_u64).sum());
        asked.app.log.say(&format!(
            "model {} saved: {}, {} KB",
            Self::said(&saved, "id"),
            Self::quoted(&saved),
            total / 1024
        ));
        Ok(Answer::json(201, &saved))
    }

    /// A field of a model's meta, for the log.
    fn said(meta: &Value, field: &str) -> String {
        // absent-ok: a field a model has not is said as nothing in the log.
        meta.get(field).map(PyText::of).unwrap_or_default()
    }

    fn quoted(meta: &Value) -> String {
        PyText::repr(&Self::said(meta, "name"))
    }

    /// `GET /api/models/<model_id>`.
    pub fn get(asked: &mut Exchange<'_>) -> Handled {
        let meta = asked.app.stores.library.get(asked.param("model_id")).map_err(Self::failed)?;
        Ok(Answer::json(200, &meta))
    }

    /// `PUT /api/models/<model_id>`.
    pub fn replace(asked: &mut Exchange<'_>) -> Handled {
        let (body, boundary) = asked.upload_bytes()?;
        let upload = Exchange::upload(&body, boundary.as_deref())?;
        let model_id = asked.param("model_id");
        let saved = asked.app.stores.library.replace(model_id, &upload.meta, &upload.files).map_err(Self::failed)?;
        asked.app.log.say(&format!("model {model_id} saved again: {}", Self::quoted(&saved)));
        Ok(Answer::json(200, &saved))
    }

    /// `POST /api/models/<model_id>/copy`.
    pub fn copy(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_object()?;
        let model_id = asked.param("model_id");
        let saved = asked.app.stores.library.copy(model_id, data.get("name")).map_err(Self::failed)?;
        asked.app.log.say(&format!(
            "model {model_id} copied to {}: {}",
            Self::said(&saved, "id"),
            Self::quoted(&saved)
        ));
        Ok(Answer::json(201, &saved))
    }

    /// `PATCH /api/models/<model_id>`.
    pub fn rename(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_object()?;
        let no_name = json!("");
        let name = data.get("name").unwrap_or(&no_name);
        let meta =
            asked.app.stores.library.rename(asked.param("model_id"), name, data.get("places")).map_err(Self::failed)?;
        Ok(Answer::json(200, &meta))
    }

    /// `DELETE /api/models/<model_id>`.
    pub fn remove(asked: &mut Exchange<'_>) -> Handled {
        let model_id = asked.param("model_id");
        asked.app.stores.library.remove(model_id).map_err(Self::failed)?;
        asked.app.log.say(&format!("model {model_id} removed"));
        Ok(Answer::empty(204))
    }

    /// `GET /api/models/<model_id>/files/<name>`.
    pub fn file(asked: &mut Exchange<'_>) -> Handled {
        let model_id = asked.param("model_id");
        let path = asked.app.stores.library.file(model_id, asked.param("name")).map_err(|error| match error {
            LibraryError::NotFound => Failure::refused(404, "no such file"),
            other => Self::failed(other),
        })?;
        let is_picture = matches!(path.extension().and_then(|ending| ending.to_str()), Some("jpg" | "png"));
        let file = match asked.asked("most").filter(|_| is_picture) {
            Some(most) => match Self::smaller(asked, &path, most, model_id)? {
                SmallerPicture::File(file) => file,
                SmallerPicture::Bytes(body) => {
                    return Ok(Answer::bytes(200, "image/jpeg", body).cached(Answer::NO_CACHE));
                }
            },
            None => path,
        };
        FileAnswer::of(&file, asked.head.headers.get("If-None-Match").as_deref())
    }

    fn smaller(asked: &Exchange<'_>, path: &Path, most: &str, model_id: &str) -> Result<SmallerPicture, Failure> {
        let most = Whole::read(most).ok_or_else(|| Failure::refused(400, "most must be a whole number"))?;
        // absent-ok: a file found by its name has one; a stem of nothing would only name its copy so.
        let stem = path.file_stem().map(|stem| stem.to_string_lossy()).unwrap_or_default();
        asked.app.stores.picture_copies.at_most(path, most, &format!("{model_id}-{stem}")).map_err(
            |error| match error {
                CopyError::OutOfRange(words) => Failure::refused(400, words),
                CopyError::NotAPicture(words) => Failure::refused(415, words),
                CopyError::Store(error) => error.into(),
            },
        )
    }
}
