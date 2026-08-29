#include "ota.h"

#include <Arduino.h>
#include <Update.h>

#include "auth.h"
#include "http_util.h"

namespace ota {

esp_err_t handler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  int total = req->content_len;
  if (total <= 0) {
    return httputil::sendError(req, "400 Bad Request", "empty firmware body");
  }

  if (!Update.begin(total)) {
    String err = "update begin failed: " + String(Update.errorString());
    return httputil::sendError(req, "500 Internal Server Error", err.c_str());
  }

  Serial.printf("[ota] receiving %d bytes\n", total);

  uint8_t buf[1024];
  int received = 0;
  while (received < total) {
    int want = total - received;
    if (want > (int)sizeof(buf)) want = sizeof(buf);
    int got = httpd_req_recv(req, (char *)buf, want);
    if (got == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (got <= 0) {
      Update.abort();
      return httputil::sendError(req, "400 Bad Request", "upload interrupted");
    }
    if (Update.write(buf, got) != (size_t)got) {
      String err = "flash write failed: " + String(Update.errorString());
      Update.abort();
      return httputil::sendError(req, "500 Internal Server Error", err.c_str());
    }
    received += got;
  }

  if (!Update.end(true)) {
    String err = "update finalise failed: " + String(Update.errorString());
    return httputil::sendError(req, "500 Internal Server Error", err.c_str());
  }

  httputil::sendJson(req, "200 OK", "{\"updated\":true,\"rebooting\":true}");
  Serial.println("[ota] complete, rebooting");
  delay(500);
  ESP.restart();
  return ESP_OK;
}

} // namespace ota
