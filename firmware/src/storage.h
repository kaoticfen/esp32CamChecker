#pragma once

#include <Arduino.h>

// Persistent settings in NVS. Wi-Fi credentials are deliberately *not* stored
// here -- WiFiManager and the ESP32 Wi-Fi stack already persist those, and
// keeping one owner avoids the two copies drifting apart.
namespace storage {

void begin();

String hubUrl();
void setHubUrl(const String &url);

String token();
void setToken(const String &token);

String name();
void setName(const String &name);

String pairingCode();
void setPairingCode(const String &code);
void clearPairingCode();

// Stable per-device identity, derived from the Wi-Fi MAC (e.g. "cam-a4cf12b0e5d8").
String deviceId();

bool isPaired();

// Reset-count factory reset. noteBoot() increments a counter on every boot and
// returns the new value; main clears it once the camera has run long enough to
// prove the boot was intentional, so only rapid RESET taps accumulate.
int noteBoot();
void clearBootCount();

// Wipes the token, hub URL, name and stored Wi-Fi credentials, then reboots
// into the setup portal.
void factoryReset();

} // namespace storage
