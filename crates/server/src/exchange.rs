//! One request, from its head to its answer.

use crate::answer::{Answer, Body, Handled};
use crate::app::App;
use crate::failure::Failure;
use crate::route::{Found, Params, Route, RouteFinder};
use files::StoreError;
use rules::{Percent, Stamp};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};
use wire::{ContentLength, Query, Reply, RequestHead};

/// One request and what it told so far: whether its body was read decides whether the connection can go on.
pub struct Exchange<'a> {
    /// What a request may need.
    pub app: &'a App,
    /// The request's line and fields.
    pub head: RequestHead,
    /// The address of the peer: the proxy's, on the NAS.
    peer: String,
    pub(crate) source: &'a mut dyn BufRead,
    pub(crate) body_read: bool,
    pub(crate) params: Params,
    pub(crate) query: Query,
    closing: bool,
    head_only: bool,
}

impl<'a> Exchange<'a> {
    /// What the proxy asks every few seconds: the log would be nothing else.
    const QUIET: &'static str = "/healthz";

    /// A request whose head was read, and whose body is still in `source`.
    pub fn new(app: &'a App, head: RequestHead, peer: String, source: &'a mut dyn BufRead) -> Self {
        let closing = !head.keeps_alive();
        let query = Query::parse(head.query());
        let head_only = head.method == "HEAD";
        Self { app, head, peer, source, body_read: false, params: Vec::new(), query, closing, head_only }
    }

    /// Answers the request, whichever way it goes, and says whether the connection stays.
    pub fn answer(&mut self, out: &mut impl Write) -> io::Result<bool> {
        let answer = self.run();
        // A route that had no use for a body left it on the connection, where it would read as the next request.
        self.close_if_body_is_left();
        self.send(&answer, out)?;
        self.note(answer.status);
        Ok(!self.closing)
    }

    fn run(&mut self) -> Answer {
        if let Some(status) = self.unknown_length() {
            self.closing = true;
            return Answer::page_of(status);
        }
        let path = Percent::decode(self.head.path());
        let method = if self.head_only { "GET".to_string() } else { self.head.method.clone() };
        match RouteFinder::find(&method, &path) {
            Found::Route(route, params) => {
                self.params = params;
                self.dispatch(route)
            }
            Found::OtherMethods(methods) if method == "OPTIONS" => {
                Answer::empty(200).field("Allow", RouteFinder::allowed(&methods))
            }
            Found::OtherMethods(methods) => Answer::page_of(405).field("Allow", RouteFinder::allowed(&methods)),
            Found::Nothing => Answer::page_of(404),
        }
    }

    /// The route's answer, or the answer to its failure. A panic in a route is one more failure: a thread of one
    /// connection, not the service.
    fn dispatch(&mut self, route: &'static Route) -> Answer {
        let ran: Result<Handled, _> = panic::catch_unwind(AssertUnwindSafe(|| (route.handler)(self)));
        match ran {
            Ok(Ok(answer)) => answer,
            Ok(Err(failure)) => self.failed(failure),
            Err(_) => self.failed(Failure::Internal("a route panicked".to_string())),
        }
    }

    fn failed(&mut self, failure: Failure) -> Answer {
        match failure {
            Failure::Refusal { status, payload } => Answer::json(status, &payload),
            Failure::Page(status) => {
                self.closing = true;
                Answer::page_of(status)
            }
            Failure::Store(StoreError::Denied(words)) => {
                self.app.log.say(&format!("cannot write: {words}"));
                let words = "The app cannot write its folder data/: give it the right to write there.";
                Answer::json(503, &json!({"error": words, "cannot_write": true}))
            }
            Failure::Store(StoreError::Failed(words)) | Failure::Internal(words) => {
                self.app.log.say(&format!("request failed: {} {}: {words}", self.head.method, self.head.path()));
                self.closing = true;
                Answer::page_of(500)
            }
        }
    }

    /// A body that comes in chunks, or of a length said wrong or twice over, cannot be told apart from the next request on
    /// the connection: such a request is refused, whatever it asks. Browsers and the proxy say one length.
    fn unknown_length(&self) -> Option<u16> {
        if self.head.headers.get("Transfer-Encoding").is_some() {
            return Some(411);
        }
        matches!(self.head.headers.content_length(), ContentLength::Other(_)).then_some(400)
    }

    fn close_if_body_is_left(&mut self) {
        let has_body = !matches!(self.head.headers.content_length(), ContentLength::Unsaid | ContentLength::Bytes(0))
            || self.head.headers.get("Transfer-Encoding").is_some();
        if has_body && !self.body_read {
            self.closing = true;
        }
    }

    /// How many bytes of a body were left unread, by what the request said. A client still sending them would hear no
    /// answer if the connection went at once: it would see a broken connection instead of the refusal.
    pub fn body_left(&self) -> u64 {
        match self.head.headers.content_length() {
            ContentLength::Bytes(size) if !self.body_read => size as u64,
            _ => 0,
        }
    }

    /// Puts the answer on the wire: the one place that says how an answer travels.
    fn send(&self, answer: &Answer, out: &mut impl Write) -> io::Result<()> {
        let mut reply = Reply::new(answer.status)
            .field("Server", "planet-terrain-maker")
            .field("Date", Stamp::http(self.app.clock.now()))
            .field("X-Content-Type-Options", "nosniff");
        if let Some(kind) = &answer.kind {
            reply = reply.field("Content-Type", kind.as_str());
            if kind.starts_with("text/html") {
                reply = reply.field("Content-Security-Policy", Answer::PAGE_POLICY);
            }
        }
        if !matches!(answer.status, 204 | 304) {
            let size = match &answer.body {
                Body::Empty => 0,
                Body::Bytes(bytes) => bytes.len() as u64,
                Body::File(_, size) => *size,
            };
            reply = reply.field("Content-Length", size.to_string());
        }
        if self.closing {
            reply = reply.field("Connection", "close");
        }
        for (name, value) in &answer.fields {
            reply = reply.field(name, value.as_str());
        }
        out.write_all(&reply.head())?;
        if !self.head_only {
            match &answer.body {
                Body::Empty => {}
                Body::Bytes(bytes) => out.write_all(bytes)?,
                Body::File(file, _) => {
                    let mut reading = file;
                    io::copy(&mut reading, out)?;
                }
            }
        }
        out.flush()
    }

    /// The log of what was asked: an address, and how it went.
    fn note(&self, status: u16) {
        if self.head.path() != Self::QUIET {
            let Self { peer, head, .. } = self;
            self.app.log.say(&format!("{peer} \"{} {} HTTP/1.{}\" {status}", head.method, head.target, head.minor));
        }
    }
}
