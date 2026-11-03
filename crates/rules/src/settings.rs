//! What is set once for every device: where each world's map opens, and a set of free-flight speeds of your own. A world
//! without its own start opens where the page itself says (`web/js/worlds.js`: Elbrus, Tranquility Base, Olympus Mons,
//! Maat Mons).

use crate::numbers::{Decimal, PyFloat};
use crate::refused::Refused;
use serde_json::{Map, Value, json};

/// The rules of the settings.
pub struct SettingRules;

impl SettingRules {
    const WORLDS: [&'static str; 4] = ["earth", "moon", "mars", "venus"];
    /// The actions of free flight whose speeds a set holds (`web/js/fly-camera.js` RATES).
    const FLY_RATES: [&'static str; 6] = ["move", "slide", "climb", "turn", "tilt", "bank"];
    const FLY_LEAST: f64 = 0.001;
    const FLY_MOST: f64 = 1.0;

    /// Refused when there is no such world.
    pub fn check_world(world: &str) -> Result<(), Refused> {
        if Self::WORLDS.contains(&world) {
            Ok(())
        } else {
            Err(Refused::new(format!("world must be one of: {}", Self::WORLDS.join(", "))))
        }
    }

    /// The starts a file holds, of the worlds there are.
    pub fn starts_of(settings: &Value) -> Value {
        let Some(starts) = settings.get("starts").and_then(Value::as_object) else {
            return json!({});
        };
        let known: Map<String, Value> = starts
            .iter()
            .filter(|(world, start)| Self::WORLDS.contains(&world.as_str()) && start.is_object())
            .map(|(world, start)| (world.clone(), start.clone()))
            .collect();
        Value::Object(known)
    }

    /// The set of speeds a file holds, or null.
    pub fn fly_preset_of(settings: &Value) -> Value {
        // absent-ok: no set of your own is null, and the page then uses its own.
        settings.get("fly_preset").filter(|preset| preset.is_object()).cloned().unwrap_or(Value::Null)
    }

    /// The start as it is kept: rounded, and refused when it does not lie on the map.
    pub fn start(
        world: &str,
        lat: Option<&Value>,
        lon: Option<&Value>,
        zoom: Option<&Value>,
    ) -> Result<Value, Refused> {
        Self::check_world(world)?;
        let refusal = || Refused::new("lat, lon and zoom must be numbers");
        let number = |value: Option<&Value>| value.and_then(Decimal::of_value).filter(|number| number.is_finite());
        let lat = number(lat).ok_or_else(refusal)?;
        let lon = number(lon).ok_or_else(refusal)?;
        let zoom = number(zoom).ok_or_else(refusal)?;
        if !((-89.0..=89.0).contains(&lat) && (-180.0..=180.0).contains(&lon) && (0.0..=22.0).contains(&zoom)) {
            return Err(Refused::new(
                "the start must lie on the map: lat within -89..89, lon within -180..180, zoom within 0..22",
            ));
        }
        Ok(json!({"lat": PyFloat::round(lat, 6), "lon": PyFloat::round(lon, 6), "zoom": PyFloat::round(zoom, 2)}))
    }

    /// The set of speeds as it is kept: {action: share of its full speed}.
    pub fn fly_preset(rates: Option<&Value>) -> Result<Value, Refused> {
        let Some(rates) = rates.and_then(Value::as_object) else {
            return Err(Refused::new("the set must be a JSON object of speeds"));
        };
        let mut preset = Map::new();
        for name in Self::FLY_RATES {
            let value = rates.get(name).and_then(Decimal::of_value).ok_or_else(|| {
                Refused::new(format!("the set needs a number for each of: {}", Self::FLY_RATES.join(", ")))
            })?;
            if !(value.is_finite() && (Self::FLY_LEAST..=Self::FLY_MOST).contains(&value)) {
                return Err(Refused::new(format!(
                    "{name} must lie within {}..{}",
                    PyFloat::repr(Self::FLY_LEAST),
                    PyFloat::repr(Self::FLY_MOST)
                )));
            }
            preset.insert(name.to_string(), Decimal::value(PyFloat::round(value, 6)));
        }
        Ok(Value::Object(preset))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_is_rounded_or_refused() {
        let start =
            |lat: Value, lon: Value, zoom: Value| SettingRules::start("moon", Some(&lat), Some(&lon), Some(&zoom));
        assert_eq!(
            start(json!(41.123456789), json!(5), json!(7.12345)).unwrap(),
            json!({"lat": 41.123457, "lon": 5.0, "zoom": 7.12})
        );
        assert_eq!(start(json!("1.5"), json!(2), json!(3)).unwrap()["lat"], 1.5);
        assert!(start(json!(95), json!(0), json!(3)).is_err());
        assert!(start(json!("x"), json!(0), json!(3)).is_err());
        assert!(start(json!(true), json!(0), json!(3)).is_err());
        assert!(SettingRules::start("pluto", None, None, None).is_err());
        assert!(SettingRules::start("moon", None, None, None).is_err());
    }

    #[test]
    fn a_set_of_speeds_is_whole_and_within_its_range() {
        let rates =
            json!({"move": 0.05, "slide": 0.05, "climb": 0.01, "turn": 0.16, "tilt": 0.1, "bank": 0.5, "other": 9});
        let preset = SettingRules::fly_preset(Some(&rates)).unwrap();
        assert_eq!(preset["turn"], 0.16);
        assert!(preset.get("other").is_none());
        let wrong = |change: Value| {
            let mut rates = rates.clone();
            rates.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
            SettingRules::fly_preset(Some(&rates)).unwrap_err().0
        };
        assert_eq!(wrong(json!({"turn": 2})), "turn must lie within 0.001..1.0");
        assert_eq!(wrong(json!({"tilt": 0})), "tilt must lie within 0.001..1.0");
        assert!(wrong(json!({"tilt": "x"})).starts_with("the set needs a number"));
        assert!(SettingRules::fly_preset(Some(&json!([1, 2]))).is_err());
        assert!(SettingRules::fly_preset(None).is_err());
    }

    #[test]
    fn what_a_file_holds() {
        let settings = json!({"starts": {"moon": {"lat": 1}, "pluto": {"lat": 2}, "mars": 5}, "fly_preset": 3});
        assert_eq!(SettingRules::starts_of(&settings), json!({"moon": {"lat": 1}}));
        assert_eq!(SettingRules::fly_preset_of(&settings), Value::Null);
        assert_eq!(SettingRules::starts_of(&json!({})), json!({}));
    }
}
