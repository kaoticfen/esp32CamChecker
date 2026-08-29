#include "stream_server.h"

#include <Arduino.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "auth.h"
#include "config.h"
#include "http_util.h"

namespace {

#define PART_BOUNDARY "esp32camframe"

const char *kStreamContentType = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
const char *kStreamBoundary = "\r\n--" PART_BOUNDARY "\r\n";
const char *kStreamPart = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

httpd_handle_t server = NULL;
SemaphoreHandle_t streamLock = NULL;

esp_err_t streamHandler(httpd_req_t *req) {
  if (!auth::check(req)) return auth::reject(req);

  // One encoder, one radio: a second concurrent stream halves the frame rate
  // for both and regularly wedges the camera driver. Say no instead.
  if (xSemaphoreTake(streamLock, 0) != pdTRUE) {
    return httputil::sendError(req, "503 Service Unavailable", "stream already in use");
  }

  esp_err_t res = httpd_resp_set_type(req, kStreamContentType);
  if (res != ESP_OK) {
    xSemaphoreGive(streamLock);
    return res;
  }
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_set_hdr(req, "Connection", "close");

  Serial.println("[stream] client connected");
  uint32_t frames = 0;
  char partHeader[64];

  while (true) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[stream] frame grab failed");
      res = ESP_FAIL;
      break;
    }

    int headerLen = snprintf(partHeader, sizeof(partHeader), kStreamPart, (unsigned)fb->len);

    res = httpd_resp_send_chunk(req, kStreamBoundary, strlen(kStreamBoundary));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, partHeader, headerLen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);

    esp_camera_fb_return(fb);
    if (res != ESP_OK) break; // client hung up

    frames++;
    // Yield so the control server and the pairing/heartbeat task still run.
    vTaskDelay(pdMS_TO_TICKS(5));
  }

  Serial.printf("[stream] client gone after %u frames\n", (unsigned)frames);
  xSemaphoreGive(streamLock);
  return ESP_OK;
}

const httpd_uri_t kStreamRoute = {"/api/stream", HTTP_GET, streamHandler, NULL};

} // namespace

namespace streamserver {

bool begin() {
  if (!streamLock) streamLock = xSemaphoreCreateMutex();

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = STREAM_PORT;
  // Must differ from the control server's control socket or the second
  // httpd_start() silently fails.
  config.ctrl_port = 32769;
  config.max_uri_handlers = 2;
  config.max_open_sockets = 2;
  config.lru_purge_enable = true;
  config.stack_size = 8192;
  config.send_wait_timeout = 10;

  if (httpd_start(&server, &config) != ESP_OK) {
    Serial.println("[stream] server failed to start");
    return false;
  }
  httpd_register_uri_handler(server, &kStreamRoute);
  Serial.printf("[stream] MJPEG on :%d\n", STREAM_PORT);
  return true;
}

} // namespace streamserver
