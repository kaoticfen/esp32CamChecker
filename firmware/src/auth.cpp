#include "auth.h"

#include <Arduino.h>
#include <memory>

#include "http_util.h"
#include "storage.h"

namespace {

// Compares in time independent of how many leading bytes match, so a caller
// cannot discover the token one byte at a time. The length itself is not
// secret -- every token we issue is the same size.
bool constantTimeEquals(const String &a, const String &b) {
  if (a.length() != b.length()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) {
    diff |= (uint8_t)a[i] ^ (uint8_t)b[i];
  }
  return diff == 0;
}

} // namespace

namespace auth {

bool check(httpd_req_t *req) {
  String expected = storage::token();
  if (expected.length() == 0) return false;

  size_t len = httpd_req_get_hdr_value_len(req, "Authorization");
  if (len == 0 || len > 256) return false;

  std::unique_ptr<char[]> header(new char[len + 1]);
  if (httpd_req_get_hdr_value_str(req, "Authorization", header.get(), len + 1) != ESP_OK) {
    return false;
  }

  String value(header.get());
  if (!value.startsWith("Bearer ")) return false;

  return constantTimeEquals(value.substring(7), expected);
}

esp_err_t reject(httpd_req_t *req) {
  httpd_resp_set_hdr(req, "WWW-Authenticate", "Bearer");
  return httputil::sendError(req, "401 Unauthorized", "invalid or missing device token");
}

} // namespace auth
