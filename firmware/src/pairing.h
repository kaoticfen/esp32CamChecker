#pragma once

namespace pairing {

// Drives the hub relationship: claims a pairing code if one is pending, then
// heartbeats so the hub always knows this camera's current IP. Call from
// loop(); it rate-limits itself.
void loop();

} // namespace pairing
