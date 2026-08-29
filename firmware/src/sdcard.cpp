#include "sdcard.h"

#include <FS.h>
#include <SD_MMC.h>
#include <esp_camera.h>
#include <time.h>

#include "config.h"
#include "http_util.h"

namespace {

bool isMounted = false;

bool endsWithIgnoreCase(const String &s, const char *suffix) {
  String lower = s;
  lower.toLowerCase();
  return lower.endsWith(suffix);
}

} // namespace

namespace sdcard {

bool begin() {
  // 1-bit mode is mandatory on the AI Thinker board: 4-bit mode claims GPIO4
  // (the flash LED) and GPIO12/13, and GPIO12 is a boot strapping pin that
  // browns the board out if a card pulls it high at reset.
  if (!SD_MMC.begin(SD_MOUNT_POINT, true)) {
    Serial.println("[sd] mount failed");
    isMounted = false;
    return false;
  }
  if (SD_MMC.cardType() == CARD_NONE) {
    Serial.println("[sd] no card present");
    SD_MMC.end();
    isMounted = false;
    return false;
  }
  isMounted = true;
  Serial.printf("[sd] mounted, %llu MB total\n", SD_MMC.cardSize() / (1024ULL * 1024ULL));
  return true;
}

bool mounted() { return isMounted; }

uint64_t totalBytes() { return isMounted ? SD_MMC.totalBytes() : 0; }
uint64_t usedBytes() { return isMounted ? SD_MMC.usedBytes() : 0; }

bool safePath(const String &in, String &out) {
  String p = in;
  if (p.length() == 0) p = "/";
  if (p[0] != '/') return false;
  if (p.length() > 255) return false;
  if (p.indexOf("..") >= 0) return false;
  for (size_t i = 0; i < p.length(); i++) {
    if (p[i] == '\0' || p[i] == '\r' || p[i] == '\n') return false;
  }
  // Collapse a trailing slash so "/DCIM/" and "/DCIM" behave identically.
  while (p.length() > 1 && p.endsWith("/")) p.remove(p.length() - 1);
  out = p;
  return true;
}

bool listJson(const String &path, String &out) {
  if (!isMounted) return false;

  File dir = SD_MMC.open(path);
  if (!dir) return false;
  if (!dir.isDirectory()) {
    dir.close();
    return false;
  }

  out = "{\"path\":\"" + httputil::jsonEscape(path) + "\",\"entries\":[";

  int count = 0;
  File entry = dir.openNextFile();
  while (entry) {
    if (count >= MAX_SD_LIST_ENTRIES) {
      entry.close();
      break;
    }
    String full = String(entry.path());
    String name = full.substring(full.lastIndexOf('/') + 1);

    if (count > 0) out += ",";
    out += "{\"name\":\"" + httputil::jsonEscape(name) + "\"";
    out += ",\"path\":\"" + httputil::jsonEscape(full) + "\"";
    out += ",\"dir\":" + String(entry.isDirectory() ? "true" : "false");
    out += ",\"size\":" + String((uint32_t)entry.size());
    out += ",\"mtime\":" + String((uint32_t)entry.getLastWrite());
    out += "}";
    count++;

    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();

  out += "],\"truncated\":";
  out += (count >= MAX_SD_LIST_ENTRIES) ? "true" : "false";
  out += "}";
  return true;
}

bool captureStill(String &pathOut, String &errOut) {
  if (!isMounted) {
    errOut = "sd card not mounted";
    return false;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    errOut = "frame grab failed";
    return false;
  }

  char dirPath[40];
  char fileName[48];
  time_t now = time(nullptr);
  // Anything before 2023 means NTP has not synced; a wall-clock name would be
  // a lie, so fall back to uptime.
  if (now > 1672531200) {
    struct tm tm;
    localtime_r(&now, &tm);
    strftime(dirPath, sizeof(dirPath), CAPTURE_ROOT "/%Y%m%d", &tm);
    char stamp[24];
    strftime(stamp, sizeof(stamp), "%H%M%S", &tm);
    snprintf(fileName, sizeof(fileName), "%s-%03lu.jpg", stamp, (unsigned long)(millis() % 1000));
  } else {
    snprintf(dirPath, sizeof(dirPath), CAPTURE_ROOT "/unsynced");
    snprintf(fileName, sizeof(fileName), "up%09lu.jpg", (unsigned long)millis());
  }

  SD_MMC.mkdir(CAPTURE_ROOT);
  SD_MMC.mkdir(dirPath);

  String full = String(dirPath) + "/" + fileName;
  File f = SD_MMC.open(full, FILE_WRITE);
  if (!f) {
    esp_camera_fb_return(fb);
    errOut = "could not open file for write";
    return false;
  }

  size_t written = f.write(fb->buf, fb->len);
  f.close();
  size_t expected = fb->len;
  esp_camera_fb_return(fb);

  if (written != expected) {
    SD_MMC.remove(full);
    errOut = "short write (card full?)";
    return false;
  }

  pathOut = full;
  Serial.printf("[sd] captured %s (%u bytes)\n", full.c_str(), (unsigned)written);
  return true;
}

const char *contentTypeFor(const String &path) {
  if (endsWithIgnoreCase(path, ".jpg") || endsWithIgnoreCase(path, ".jpeg")) return "image/jpeg";
  if (endsWithIgnoreCase(path, ".png")) return "image/png";
  if (endsWithIgnoreCase(path, ".gif")) return "image/gif";
  if (endsWithIgnoreCase(path, ".avi")) return "video/x-msvideo";
  if (endsWithIgnoreCase(path, ".mp4")) return "video/mp4";
  if (endsWithIgnoreCase(path, ".mjpeg") || endsWithIgnoreCase(path, ".mjpg")) return "video/x-motion-jpeg";
  if (endsWithIgnoreCase(path, ".txt") || endsWithIgnoreCase(path, ".log")) return "text/plain";
  if (endsWithIgnoreCase(path, ".json")) return "application/json";
  return "application/octet-stream";
}

} // namespace sdcard
