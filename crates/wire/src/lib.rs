//! HTTP/1.1 messages on a stream: a request's head off the wire, a reply's head, a URL's query, a multipart body. It
//! knows nothing of this app: no route, no store. Reading is generic over `BufRead`, which is how the tests drive it
//! without a socket; the socket itself is the server's.

pub mod headers;
pub mod multipart;
pub mod query;
pub mod reply;
pub mod request;

pub use headers::{ContentLength, Headers};
pub use multipart::{Multipart, MultipartError, Part};
pub use query::Query;
pub use reply::Reply;
pub use request::{HeadError, RequestHead};
