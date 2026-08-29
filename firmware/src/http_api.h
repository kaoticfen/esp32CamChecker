#pragma once

namespace httpapi {

// Control API on CONTROL_PORT. Streaming lives on its own server (see
// stream_server.h) so a long-running stream can never block a control call.
bool begin();

} // namespace httpapi
