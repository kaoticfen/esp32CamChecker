#pragma once

#include <Arduino.h>

namespace wifiprov {

// Connects with stored credentials, or raises the setup access point and runs
// the captive portal. Blocks until connected or the portal times out.
bool begin();

// SSID of the setup access point for this board, e.g. "esp32cam-setup-b0e5d8".
String apName();

} // namespace wifiprov
