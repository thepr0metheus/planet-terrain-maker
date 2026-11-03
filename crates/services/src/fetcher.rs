//! Requests to the services: one place that sets who we say we are, how long we wait, and what a failure looks like.

use std::fmt;
use std::time::Duration;
use ureq::Agent;

/// What a service sent: the body, its type, and the status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// The body.
    pub body: Vec<u8>,
    /// The type of its content; "" when it says none.
    pub content_type: String,
    /// The status.
    pub status: u16,
}

/// A service did not give what was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    message: String,
    /// Its HTTP status; `None` when it did not answer at all (network, timeout).
    pub status: Option<u16>,
}

impl FetchError {
    /// A failure in these words, with no status.
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), status: None }
    }

    /// The service answered with this status.
    pub fn of_status(status: u16) -> Self {
        Self { message: format!("HTTP {status}"), status: Some(status) }
    }

    /// Whether the next request may well get what this one did not: a busy service answers 5xx, 429 or nothing.
    pub fn is_passing(&self) -> bool {
        self.status.is_none_or(|status| status == 429 || status >= 500)
    }
}

impl fmt::Display for FetchError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}

/// GET and POST with our name on them. A status outside 2xx is a `FetchError`, so that a caller never mistakes an error
/// page for data. A trait, so that a test can stand in for the outside world.
pub trait Fetch: Send + Sync {
    /// Asks for this address, waiting at most this many seconds to connect, and as long for each read and each write: a
    /// slow answer that keeps coming is waited for.
    fn get(&self, url: &str, headers: &[(&str, &str)], seconds: u64) -> Result<Answer, FetchError>;

    /// Sends this body to this address.
    fn post(&self, url: &str, body: &[u8], headers: &[(&str, &str)], seconds: u64) -> Result<Answer, FetchError>;
}

/// The real thing: HTTPS, with Mozilla's roots compiled in, on plain threads. Connections are reused where a service
/// allows it, which a burst of tiles asks for.
pub struct HttpFetcher {
    agent: Agent,
    #[cfg(feature = "test-upstream")]
    local: Option<String>,
}

impl HttpFetcher {
    /// The most bytes an answer may have: nothing the app asks for comes near it, and an endless one must not take the
    /// memory.
    const MOST_ANSWER: u64 = 512 * 1024 * 1024;
    const IDLE_CONNECTIONS: usize = 32;
    const IDLE_CONNECTIONS_A_HOST: usize = 8;

    /// A client that says this name. Nominatim and Overpass ask every application to say who it is.
    pub fn new(user_agent: &str) -> Self {
        Self {
            agent: Self::agent(user_agent, true),
            #[cfg(feature = "test-upstream")]
            local: None,
        }
    }

    /// The tests' door: every service is asked at this local address, its host the first piece of the path.
    #[cfg(feature = "test-upstream")]
    pub fn local(user_agent: &str, address: String) -> Self {
        Self { agent: Self::agent(user_agent, false), local: Some(address) }
    }

    fn agent(user_agent: &str, https_only: bool) -> Agent {
        Agent::config_builder()
            .http_status_as_error(false)
            .https_only(https_only)
            .user_agent(user_agent)
            .max_idle_connections(Self::IDLE_CONNECTIONS)
            .max_idle_connections_per_host(Self::IDLE_CONNECTIONS_A_HOST)
            .build()
            .into()
    }

    #[cfg(feature = "test-upstream")]
    fn address(&self, url: &str) -> String {
        match &self.local {
            Some(local) => format!("http://{local}/{}", url.trim_start_matches("https://")),
            None => url.to_string(),
        }
    }

    #[cfg(not(feature = "test-upstream"))]
    fn address(&self, url: &str) -> String {
        url.to_string()
    }

    fn read(answered: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Answer, FetchError> {
        let mut response = answered.map_err(|error| FetchError::new(format!("no answer: {error}")))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(FetchError::of_status(status));
        }
        let kind = response.headers().get("content-type").and_then(|kind| kind.to_str().ok());
        // absent-ok: a service that names no type sends "no type", which is what a caller says of it.
        let content_type = kind.unwrap_or_default().to_string();
        let body = response
            .body_mut()
            .with_config()
            .limit(Self::MOST_ANSWER)
            .read_to_vec()
            .map_err(|error| FetchError::new(format!("no answer: {error}")))?;
        Ok(Answer { body, content_type, status })
    }

    fn step(seconds: u64) -> Option<Duration> {
        Some(Duration::from_secs(seconds))
    }
}

impl Fetch for HttpFetcher {
    fn get(&self, url: &str, headers: &[(&str, &str)], seconds: u64) -> Result<Answer, FetchError> {
        let mut request = self.agent.get(self.address(url));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let step = Self::step(seconds);
        Self::read(request.config().timeout_connect(step).timeout_per_read(step).timeout_per_write(step).build().call())
    }

    fn post(&self, url: &str, body: &[u8], headers: &[(&str, &str)], seconds: u64) -> Result<Answer, FetchError> {
        let mut request = self.agent.post(self.address(url));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let step = Self::step(seconds);
        Self::read(
            request.config().timeout_connect(step).timeout_per_read(step).timeout_per_write(step).build().send(body),
        )
    }
}

#[cfg(test)]
pub(crate) mod fakes {
    //! A fake of the outside world, for what HTTP cannot show.

    use super::*;
    use files::Locked;

    /// Answers from a table of URL parts; a URL no part finds fails with status 599.
    pub(crate) struct FakeFetch {
        pub(crate) table: Vec<(&'static str, Result<Answer, FetchError>)>,
        pub(crate) asked: Locked<Vec<String>>,
    }

    impl FakeFetch {
        pub(crate) fn new(table: Vec<(&'static str, Result<Answer, FetchError>)>) -> Self {
            Self { table, asked: Locked::new(Vec::new()) }
        }
    }

    pub(crate) fn answer(body: &[u8], kind: &str) -> Result<Answer, FetchError> {
        Ok(Answer { body: body.to_vec(), content_type: kind.to_string(), status: 200 })
    }

    impl Fetch for FakeFetch {
        fn get(&self, url: &str, _: &[(&str, &str)], _: u64) -> Result<Answer, FetchError> {
            self.asked.with(|asked| asked.push(url.to_string()));
            let found = self.table.iter().find(|(part, _)| url.contains(part));
            found.map_or_else(|| Err(FetchError::of_status(599)), |(_, answer)| answer.clone())
        }

        fn post(&self, url: &str, _: &[u8], headers: &[(&str, &str)], seconds: u64) -> Result<Answer, FetchError> {
            self.get(url, headers, seconds)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_passes_and_what_does_not() {
        assert!(FetchError::new("no answer").is_passing());
        for status in [429, 500, 503] {
            assert!(FetchError::of_status(status).is_passing(), "{status}");
        }
        for status in [400, 403, 404] {
            assert!(!FetchError::of_status(status).is_passing(), "{status}");
        }
        assert_eq!(FetchError::of_status(500).to_string(), "HTTP 500");
    }
}
