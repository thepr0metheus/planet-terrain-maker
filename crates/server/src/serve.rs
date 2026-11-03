//! The sockets: one thread to a connection, requests on it one after another.

use crate::app::App;
use crate::exchange::Exchange;
use std::io::{self, BufReader, BufWriter, Read as _, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use wire::{HeadError, RequestHead};

/// A listening socket and what its requests may need.
pub struct Server {
    listener: TcpListener,
    app: Arc<App>,
}

impl Server {
    /// An idle keep-alive connection closes after this, and so does one that stops halfway. A proxy opens another as it
    /// needs.
    const TIMEOUT: Duration = Duration::from_secs(30);
    const LINGER: Duration = Duration::from_secs(2);
    const LINGER_BYTES: u64 = 512 * 1024 * 1024;

    /// Binds the socket.
    pub fn bind(app: Arc<App>, host: &str, port: u16) -> io::Result<Self> {
        Ok(Self { listener: TcpListener::bind((host, port))?, app })
    }

    /// Serves until the process stops. A connection that fails takes only itself away.
    pub fn run(&self) {
        for connection in self.listener.incoming() {
            match connection {
                Err(error) => self.app.log.say(&format!("a connection was not taken: {error}")),
                Ok(stream) => {
                    let app = Arc::clone(&self.app);
                    let started =
                        thread::Builder::new().name("connection".to_string()).spawn(move || Self::serve(&app, stream));
                    if let Err(error) = started {
                        self.app.log.say(&format!("no thread for a connection: {error}"));
                    }
                }
            }
        }
    }

    fn serve(app: &App, stream: TcpStream) {
        if let Err(error) = Self::requests(app, stream) {
            // An idle connection closing after its time, or a client gone, is routine.
            if !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
            ) {
                app.log.say(&format!("a connection failed: {error}"));
            }
        }
    }

    fn requests(app: &App, stream: TcpStream) -> io::Result<()> {
        stream.set_read_timeout(Some(Self::TIMEOUT))?;
        stream.set_write_timeout(Some(Self::TIMEOUT))?;
        // absent-ok: a peer whose address the system no longer knows has gone; its request, if any, reads as from nobody known.
        let peer = stream.peer_addr().map(|address| address.ip().to_string()).unwrap_or_default();
        let mut source = BufReader::new(stream.try_clone()?);
        let mut out = BufWriter::new(stream);
        loop {
            let head = match RequestHead::read(&mut source) {
                Ok(head) => head,
                Err(HeadError::Closed) => return Ok(()),
                Err(HeadError::Io(error)) => return Err(error),
                Err(HeadError::Malformed(words)) => return Self::bad_request(&mut out, &words),
            };
            if head.expects_continue() {
                out.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
                out.flush()?;
            }
            let mut exchange = Exchange::new(app, head, peer.clone(), &mut source);
            if !exchange.answer(&mut out)? {
                let left = exchange.body_left();
                Self::read_what_is_left(&mut source, left);
                return Ok(());
            }
        }
    }

    /// Lets a client that is still sending finish, and so read the answer it already has. A client that stops sending
    /// holds this no longer than `LINGER`, and one that sends without end no longer than `LINGER_BYTES`.
    fn read_what_is_left(source: &mut BufReader<TcpStream>, left: u64) {
        if left == 0 || source.get_ref().set_read_timeout(Some(Self::LINGER)).is_err() {
            return;
        }
        // Whatever comes of this, the connection goes and the answer was sent.
        drop(io::copy(&mut source.by_ref().take(left.min(Self::LINGER_BYTES)), &mut io::sink()));
    }

    /// Bytes that are no request: said in few words, and the connection goes.
    fn bad_request(out: &mut impl Write, words: &str) -> io::Result<()> {
        let body = format!("Bad request: {words}\n");
        write!(
            out,
            "HTTP/1.1 400 Bad Request\r\nServer: planet-terrain-maker\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )?;
        out.flush()
    }
}
