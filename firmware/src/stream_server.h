#pragma once

namespace streamserver {

// MJPEG on STREAM_PORT. Exactly one client at a time -- the second gets a 503.
// The hub is expected to be that one client and to fan frames out itself.
bool begin();

} // namespace streamserver
