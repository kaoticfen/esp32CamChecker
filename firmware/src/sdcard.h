#pragma once

#include <Arduino.h>

namespace sdcard {

bool begin();
bool mounted();

uint64_t totalBytes();
uint64_t usedBytes();

// Normalises a caller-supplied path and rejects anything that could escape the
// card root. Returns false for relative paths, `..` segments, and NUL bytes.
bool safePath(const String &in, String &out);

// JSON array of directory entries. Truncated at MAX_SD_LIST_ENTRIES.
bool listJson(const String &path, String &out);

// Grabs a frame and writes it to /DCIM/YYYYMMDD/. Falls back to an uptime
// based name when NTP has not synced yet.
bool captureStill(String &pathOut, String &errOut);

const char *contentTypeFor(const String &path);

} // namespace sdcard
