//! The server of Planet Terrain Maker: the page itself (`web/`), and the API the page works through. Everything the page
//! needs from other services goes through here: map tiles (kept on disk), heights, names, buildings. The saved models
//! live here too.

mod answer;
mod app;
mod clock;
mod exchange;
mod failure;
mod file_answer;
mod openapi;
mod packages;
mod process;
mod request_body;
mod request_query;
mod route;
mod route_table;
mod routes;
mod serve;
mod settings;

use std::process::ExitCode;

fn main() -> ExitCode {
    process::Process::run(std::env::args().skip(1).collect())
}
