//! What the environment says.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The server's settings, read once. `web/` and `VERSION` lie in the folder it starts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// The address it listens on.
    pub host: String,
    /// The port it listens on.
    pub port: u16,
    /// The data folder.
    pub data: PathBuf,
    /// The page.
    pub web: PathBuf,
    /// The file that names the commit.
    pub version_file: PathBuf,
    /// The most bytes of map tiles kept.
    pub tile_cache_bytes: u64,
    /// The key of the environment.
    pub opentopo_key: Option<String>,
    /// Who we say we are to the services: `APP_USER_AGENT` may add a way to reach whoever runs this copy (an address or a
    /// page), as the usage policies of Nominatim and Overpass ask.
    pub user_agent: String,
    /// The tests' door: the services are asked at this local address.
    #[cfg(feature = "test-upstream")]
    pub test_upstream: Option<String>,
}

impl Settings {
    const PORT: u16 = 15002;
    const TILE_CACHE_MB: u64 = 4096;
    const USER_AGENT: &'static str = "planet-terrain-maker/1.0";

    /// The settings this environment says, for a server that starts in `base`.
    pub fn from_env(env: &HashMap<String, String>, base: &Path) -> Result<Self, String> {
        let said = |name: &str| env.get(name).filter(|value| !value.is_empty()).cloned();
        let port = match said("APP_PORT") {
            Some(port) => port.parse().map_err(|_| format!("APP_PORT is no port: {port}"))?,
            None => Self::PORT,
        };
        let tile_cache_mb: u64 = match said("TILE_CACHE_MB") {
            Some(size) => size.parse().map_err(|_| format!("TILE_CACHE_MB is no number: {size}"))?,
            None => Self::TILE_CACHE_MB,
        };
        Ok(Self {
            host: said("APP_HOST").unwrap_or_else(|| "127.0.0.1".to_string()),
            port,
            data: said("APP_DATA").map_or_else(|| base.join("data"), PathBuf::from),
            web: base.join("web"),
            version_file: base.join("VERSION"),
            tile_cache_bytes: tile_cache_mb
                .checked_mul(1024 * 1024)
                .ok_or_else(|| format!("TILE_CACHE_MB is more than a disk holds: {tile_cache_mb}"))?,
            opentopo_key: said("OPENTOPO_KEY"),
            user_agent: said("APP_USER_AGENT").unwrap_or_else(|| Self::USER_AGENT.to_string()),
            #[cfg(feature = "test-upstream")]
            test_upstream: said("PTM_TEST_UPSTREAM"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(pairs: &[(&str, &str)]) -> Result<Settings, String> {
        let env = pairs.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        Settings::from_env(&env, Path::new("/app"))
    }

    #[test]
    fn what_it_takes_when_nothing_is_said() {
        let settings = of(&[]).unwrap();
        assert_eq!((settings.host.as_str(), settings.port), ("127.0.0.1", 15002));
        assert_eq!(settings.data, Path::new("/app/data"));
        assert_eq!(settings.web, Path::new("/app/web"));
        assert_eq!(settings.tile_cache_bytes, 4096 * 1024 * 1024);
        assert_eq!(settings.opentopo_key, None);
        assert_eq!(settings.user_agent, "planet-terrain-maker/1.0");
    }

    #[test]
    fn what_is_said_and_what_cannot_be() {
        let settings =
            of(&[("APP_PORT", "18160"), ("APP_DATA", "/d"), ("TILE_CACHE_MB", "1"), ("OPENTOPO_KEY", "k")]).unwrap();
        assert_eq!((settings.port, settings.tile_cache_bytes), (18160, 1024 * 1024));
        assert_eq!(settings.data, Path::new("/d"));
        assert_eq!(settings.opentopo_key.as_deref(), Some("k"));
        assert!(of(&[("APP_PORT", "x")]).is_err());
        assert!(of(&[("TILE_CACHE_MB", "x")]).is_err());
        assert!(of(&[("TILE_CACHE_MB", "99999999999999999")]).is_err());
    }
}
