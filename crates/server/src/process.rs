//! The process: the one place that reads the real environment and the command line, and hands them to the objects.

use crate::app::App;
use crate::openapi::ApiDescription;
use crate::route_table::ROUTES;
use crate::serve::Server;
use crate::settings::Settings;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

/// `planet-terrain-maker`: wires the parts and serves until stopped. `planet-terrain-maker healthcheck`: asks the running
/// service, for Docker's HEALTHCHECK. `planet-terrain-maker api-doc`: writes the page for people about the API.
pub struct Process;

impl Process {
    const USAGE: &'static str = "usage: planet-terrain-maker [healthcheck | api-doc]\n";

    /// Runs what the command line says.
    pub fn run(args: Vec<String>) -> ExitCode {
        let env: HashMap<String, String> = env::vars().collect();
        let base = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let settings = match Settings::from_env(&env, &base) {
            Ok(settings) => settings,
            Err(words) => return Self::stop(&words),
        };
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match args.as_slice() {
            [] => Self::serve(&settings),
            ["healthcheck"] => Self::healthcheck(&settings),
            ["api-doc"] => Self::api_doc(),
            _ => Self::stop(Self::USAGE.trim_end()),
        }
    }

    /// Says why, on the standard error, and stops.
    fn stop(words: &str) -> ExitCode {
        // What cannot say why still stops: the exit code says that much.
        drop(io::stderr().write_all(format!("{words}\n").as_bytes()));
        ExitCode::FAILURE
    }

    fn api_doc() -> ExitCode {
        let page = ApiDescription::markdown(&ApiDescription::build(&ROUTES, None));
        match io::stdout().write_all(page.as_bytes()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => Self::stop(&error.to_string()),
        }
    }

    /// Docker's question: is the service answering.
    fn healthcheck(settings: &Settings) -> ExitCode {
        match Self::asked_health(settings.port) {
            Ok(head) if head.starts_with("HTTP/1.1 200") => ExitCode::SUCCESS,
            Ok(head) => Self::stop(&format!("/healthz: {}", head.lines().next().unwrap_or(&head))),
            Err(error) => Self::stop(&format!("/healthz: {error}")),
        }
    }

    fn asked_health(port: u16) -> io::Result<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer)?;
        Ok(answer)
    }

    fn serve(settings: &Settings) -> ExitCode {
        if let Err(error) = fs::create_dir_all(&settings.data) {
            return Self::stop(&format!("{}: {error}", settings.data.display()));
        }
        let app = match App::new(settings) {
            Ok(app) => Arc::new(app),
            Err(words) => return Self::stop(&words),
        };
        let server = match Server::bind(Arc::clone(&app), &settings.host, settings.port) {
            Ok(server) => server,
            Err(error) => return Self::stop(&format!("{}:{}: {error}", settings.host, settings.port)),
        };
        for words in app.stores.library.recover() {
            app.log.say(&words);
        }
        let shown = app.version.as_deref().unwrap_or("working copy");
        let (host, port, data) = (&settings.host, settings.port, settings.data.display());
        app.log.say(&format!("Planet Terrain Maker {shown} on http://{host}:{port}/, data in {data}"));
        server.run();
        ExitCode::SUCCESS
    }
}
