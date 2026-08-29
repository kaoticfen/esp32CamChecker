#pragma once

#include <Arduino.h>
#include <esp_camera.h>

namespace camera {

bool begin();
bool hasPsram();

// Applies one named sensor setting. Returns false for unknown keys or values
// the sensor rejects.
bool applySetting(const String &key, int value);

// Current settings as a JSON object body (no surrounding braces omitted --
// this returns a complete object).
String settingsJson();

void setFlash(bool on);
bool flashOn();

} // namespace camera
