//! What is set once for every device.

use crate::answer::{Answer, Handled};
use crate::exchange::Exchange;
use crate::failure::Failure;
use files::SettingsError;
use rules::PyText;
use serde_json::json;

/// The addresses of the settings.
pub struct SettingRoutes;

impl SettingRoutes {
    fn failed(error: SettingsError) -> Failure {
        match error {
            SettingsError::Refused(refused) => Failure::refused(400, refused.0),
            SettingsError::Store(error) => error.into(),
        }
    }

    /// `GET /api/settings`.
    pub fn read(asked: &mut Exchange<'_>) -> Handled {
        let stores = &asked.app.stores;
        Ok(Answer::json(
            200,
            &json!({
                "opentopo_key": stores.keys.source()?,
                "starts": stores.settings.starts()?,
                "fly_preset": stores.settings.fly_preset()?,
            }),
        ))
    }

    /// `PUT /api/settings/fly-preset`.
    pub fn set_fly_preset(asked: &mut Exchange<'_>) -> Handled {
        let rates = asked.json_value()?;
        let preset = asked.app.stores.settings.set_fly_preset(rates.as_ref()).map_err(Self::failed)?;
        Ok(Answer::json(200, &preset))
    }

    /// `PUT /api/settings/start/<world>`.
    pub fn set_start(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_object()?;
        let world = asked.param("world");
        let start = asked
            .app
            .stores
            .settings
            .set_start(world, data.get("lat"), data.get("lon"), data.get("zoom"))
            .map_err(Self::failed)?;
        Ok(Answer::json(200, &start))
    }

    /// `DELETE /api/settings/start/<world>`.
    pub fn clear_start(asked: &mut Exchange<'_>) -> Handled {
        asked.app.stores.settings.clear_start(asked.param("world")).map_err(Self::failed)?;
        Ok(Answer::empty(204))
    }

    /// `PUT /api/settings/opentopo-key`.
    pub fn set_key(asked: &mut Exchange<'_>) -> Handled {
        let data = asked.json_object()?;
        // absent-ok: no key sent is an empty one, which is refused as no key.
        let key = data.get("key").map(PyText::of).unwrap_or_default();
        match asked.app.stores.keys.set(&key)? {
            Ok(()) => {
                asked.app.log.say("opentopography key: set from the page");
                Ok(Answer::empty(204))
            }
            Err(refused) => Err(Failure::refused(400, refused.0)),
        }
    }

    /// `DELETE /api/settings/opentopo-key`.
    pub fn clear_key(asked: &mut Exchange<'_>) -> Handled {
        asked.app.stores.keys.clear()?;
        asked.app.log.say("opentopography key: removed from the page");
        Ok(Answer::empty(204))
    }
}
