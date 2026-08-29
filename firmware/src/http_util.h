#pragma once

#include <Arduino.h>
#include <esp_http_server.h>

namespace httputil {

// Reads `key` out of the request query string, URL-decoded.
bool queryParam(httpd_req_t *req, const char *key, String &out);

// Reads the whole request body. Fails (rather than truncating) if the body is
// larger than `maxLen`.
bool readBody(httpd_req_t *req, String &out, size_t maxLen);

esp_err_t sendJson(httpd_req_t *req, const char *status, const String &json);
esp_err_t sendError(httpd_req_t *req, const char *status, const char *message);

String urlDecode(const String &in);
String jsonEscape(const String &in);

} // namespace httputil
