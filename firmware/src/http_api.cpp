#include "http_api.h"

#include <ArduinoJson.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <esp_camera.h>

#include "auth.h"
#include "camera.h"
#include "config.h"
#include "http_util.h"
#include "ota.h"
#include "sdcard.h"
#include "storage.h"

namespace {

httpd_handle_t server = NULL;

esp_err_t infoHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  String json = "{";
  json += "\"deviceId\":\"" + httputil::jsonEscape(storage::deviceId()) + "\"";
  json += ",\"name\":\"" + httputil::jsonEscape(storage::name()) + "\"";
  json += ",\"fwVersion\":\"" FW_VERSION "\"";
  json += ",\"uptimeMs\":" + String((uint32_t)millis());
  json += ",\"ip\":\"" + WiFi.localIP().toString() + "\"";
  json += ",\"rssi\":" + String(WiFi.RSSI());
  json += ",\"psram\":" + String(camera::hasPsram() ? "true" : "false");
  json += ",\"heapFree\":" + String((uint32_t)ESP.getFreeHeap());
  json += ",\"sd\":{\"mounted\":" + String(sdcard::mounted() ? "true" : "false");
  // Kilobytes, not bytes: a 64GB card overflows the uint32 these are cast to.
  json += ",\"totalKb\":" + String((uint32_t)(sdcard::totalBytes() / 1024));
  json += ",\"usedKb\":" + String((uint32_t)(sdcard::usedBytes() / 1024)) + "}";
  json += ",\"settings\":" + camera::settingsJson();
  json += "}";

  return httputil::sendJson(req, "200 OK", json);
}

esp_err_t snapshotHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return httputil::sendError(req, "503 Service Unavailable", "frame grab failed");

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

esp_err_t captureHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  String path, err;
  if (!sdcard::captureStill(path, err)) {
    return httputil::sendError(req, "500 Internal Server Error", err.c_str());
  }
  return httputil::sendJson(req, "200 OK",
                            "{\"path\":\"" + httputil::jsonEscape(path) + "\"}");
}

esp_err_t settingsHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  String body;
  if (!httputil::readBody(req, body, 1024)) {
    return httputil::sendError(req, "400 Bad Request", "missing or oversized body");
  }

  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok || !doc.is<JsonObject>()) {
    return httputil::sendError(req, "400 Bad Request", "body must be a JSON object");
  }

  int applied = 0;
  String rejected;
  for (JsonPair kv : doc.as<JsonObject>()) {
    String key(kv.key().c_str());
    if (camera::applySetting(key, kv.value().as<int>())) {
      applied++;
    } else {
      if (rejected.length()) rejected += ",";
      rejected += key;
    }
  }

  String json = "{\"applied\":" + String(applied);
  json += ",\"rejected\":\"" + httputil::jsonEscape(rejected) + "\"";
  json += ",\"settings\":" + camera::settingsJson() + "}";
  return httputil::sendJson(req, "200 OK", json);
}

esp_err_t rebootHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);
  httputil::sendJson(req, "200 OK", "{\"rebooting\":true}");
  delay(250);
  ESP.restart();
  return ESP_OK;
}

esp_err_t factoryResetHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);
  httputil::sendJson(req, "200 OK", "{\"factoryReset\":true}");
  delay(250);
  storage::factoryReset(); // reboots
  return ESP_OK;
}

esp_err_t sdListHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);
  if (!sdcard::mounted()) {
    return httputil::sendError(req, "503 Service Unavailable", "sd card not mounted");
  }

  String raw = "/";
  httputil::queryParam(req, "path", raw);

  String path;
  if (!sdcard::safePath(raw, path)) {
    return httputil::sendError(req, "400 Bad Request", "invalid path");
  }

  String json;
  if (!sdcard::listJson(path, json)) {
    return httputil::sendError(req, "404 Not Found", "not a directory");
  }
  return httputil::sendJson(req, "200 OK", json);
}

esp_err_t sdFileHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);
  if (!sdcard::mounted()) {
    return httputil::sendError(req, "503 Service Unavailable", "sd card not mounted");
  }

  String raw, path;
  if (!httputil::queryParam(req, "path", raw) || !sdcard::safePath(raw, path)) {
    return httputil::sendError(req, "400 Bad Request", "invalid path");
  }

  File f = SD_MMC.open(path, FILE_READ);
  if (!f) return httputil::sendError(req, "404 Not Found", "no such file");
  if (f.isDirectory()) {
    f.close();
    return httputil::sendError(req, "400 Bad Request", "path is a directory");
  }

  size_t total = f.size();
  size_t start = 0;
  size_t end = total ? total - 1 : 0;
  bool partial = false;

  size_t rangeLen = httpd_req_get_hdr_value_len(req, "Range");
  if (rangeLen > 0 && rangeLen < 64) {
    char rangeBuf[64];
    if (httpd_req_get_hdr_value_str(req, "Range", rangeBuf, sizeof(rangeBuf)) == ESP_OK) {
      unsigned long rs = 0, re = 0;
      if (sscanf(rangeBuf, "bytes=%lu-%lu", &rs, &re) == 2) {
        start = rs;
        end = re;
        partial = true;
      } else if (sscanf(rangeBuf, "bytes=%lu-", &rs) == 1) {
        start = rs;
        end = total ? total - 1 : 0;
        partial = true;
      }
    }
  }

  if (partial && (total == 0 || start >= total)) {
    f.close();
    char contentRange[48];
    snprintf(contentRange, sizeof(contentRange), "bytes */%u", (unsigned)total);
    httpd_resp_set_hdr(req, "Content-Range", contentRange);
    return httputil::sendError(req, "416 Range Not Satisfiable", "range outside file");
  }
  if (end >= total && total > 0) end = total - 1;

  httpd_resp_set_type(req, sdcard::contentTypeFor(path));
  httpd_resp_set_hdr(req, "Accept-Ranges", "bytes");
  httpd_resp_set_hdr(req, "Cache-Control", "private, max-age=86400");

  if (partial) {
    char contentRange[64];
    snprintf(contentRange, sizeof(contentRange), "bytes %u-%u/%u", (unsigned)start,
             (unsigned)end, (unsigned)total);
    httpd_resp_set_hdr(req, "Content-Range", contentRange);
    httpd_resp_set_status(req, "206 Partial Content");
  }

  // esp_http_server always chunks a multi-call response, so this reply carries
  // no Content-Length. That is fine here because the hub is the only client and
  // it re-serves the body to browsers with an exact length (see proxy.ts).
  f.seek(start);
  size_t remaining = (total == 0) ? 0 : (end - start + 1);
  uint8_t buf[SD_CHUNK_SIZE];
  esp_err_t res = ESP_OK;
  while (remaining > 0) {
    size_t want = remaining < sizeof(buf) ? remaining : sizeof(buf);
    size_t got = f.read(buf, want);
    if (got == 0) break;
    res = httpd_resp_send_chunk(req, (const char *)buf, got);
    if (res != ESP_OK) break;
    remaining -= got;
  }
  f.close();

  if (res == ESP_OK) httpd_resp_send_chunk(req, NULL, 0);
  return res;
}

esp_err_t sdDeleteHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);
  if (!sdcard::mounted()) {
    return httputil::sendError(req, "503 Service Unavailable", "sd card not mounted");
  }

  String raw, path;
  if (!httputil::queryParam(req, "path", raw) || !sdcard::safePath(raw, path)) {
    return httputil::sendError(req, "400 Bad Request", "invalid path");
  }
  if (path == "/") return httputil::sendError(req, "400 Bad Request", "refusing to delete root");

  File f = SD_MMC.open(path);
  if (!f) return httputil::sendError(req, "404 Not Found", "no such file");
  bool isDir = f.isDirectory();
  f.close();

  bool ok = isDir ? SD_MMC.rmdir(path) : SD_MMC.remove(path);
  if (!ok) return httputil::sendError(req, "500 Internal Server Error", "delete failed");
  return httputil::sendJson(req, "200 OK", "{\"deleted\":true}");
}

const httpd_uri_t kRoutes[] = {
    {"/api/info", HTTP_GET, infoHandler, NULL},
    {"/api/snapshot", HTTP_GET, snapshotHandler, NULL},
    {"/api/capture", HTTP_POST, captureHandler, NULL},
    {"/api/settings", HTTP_POST, settingsHandler, NULL},
    {"/api/reboot", HTTP_POST, rebootHandler, NULL},
    {"/api/factory-reset", HTTP_POST, factoryResetHandler, NULL},
    {"/api/sd/list", HTTP_GET, sdListHandler, NULL},
    {"/api/sd/file", HTTP_GET, sdFileHandler, NULL},
    {"/api/sd/file", HTTP_DELETE, sdDeleteHandler, NULL},
    {"/api/ota", HTTP_POST, ota::handler, NULL},
};

} // namespace

namespace httpapi {

bool begin() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = CONTROL_PORT;
  config.ctrl_port = 32768;
  config.max_uri_handlers = sizeof(kRoutes) / sizeof(kRoutes[0]) + 2;
  config.lru_purge_enable = true;
  config.stack_size = 8192;
  // OTA uploads are large and the SD reads are slow; a stingy timeout makes
  // both look like random connection failures.
  config.recv_wait_timeout = 30;
  config.send_wait_timeout = 30;

  if (httpd_start(&server, &config) != ESP_OK) {
    Serial.println("[http] control server failed to start");
    return false;
  }
  for (const httpd_uri_t &route : kRoutes) {
    httpd_register_uri_handler(server, &route);
  }
  Serial.printf("[http] control API on :%d\n", CONTROL_PORT);
  return true;
}

} // namespace httpapi
