#include "http_util.h"

#include <memory>

namespace {

int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

} // namespace

namespace httputil {

String urlDecode(const String &in) {
  String out;
  out.reserve(in.length());
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '+') {
      out += ' ';
    } else if (c == '%' && i + 2 < in.length()) {
      int hi = hexVal(in[i + 1]);
      int lo = hexVal(in[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out += (char)((hi << 4) | lo);
        i += 2;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

String jsonEscape(const String &in) {
  String out;
  out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    switch (c) {
    case '"': out += "\\\""; break;
    case '\\': out += "\\\\"; break;
    case '\n': out += "\\n"; break;
    case '\r': out += "\\r"; break;
    case '\t': out += "\\t"; break;
    default:
      if ((uint8_t)c < 0x20) {
        char buf[7];
        snprintf(buf, sizeof(buf), "\\u%04x", c);
        out += buf;
      } else {
        out += c;
      }
    }
  }
  return out;
}

bool queryParam(httpd_req_t *req, const char *key, String &out) {
  size_t len = httpd_req_get_url_query_len(req);
  if (len == 0 || len > 512) return false;

  std::unique_ptr<char[]> query(new char[len + 1]);
  if (httpd_req_get_url_query_str(req, query.get(), len + 1) != ESP_OK) return false;

  char value[256];
  if (httpd_query_key_value(query.get(), key, value, sizeof(value)) != ESP_OK) return false;

  out = urlDecode(String(value));
  return true;
}

bool readBody(httpd_req_t *req, String &out, size_t maxLen) {
  int total = req->content_len;
  if (total <= 0 || (size_t)total > maxLen) return false;

  out = "";
  out.reserve(total + 1);

  char buf[257];
  int received = 0;
  while (received < total) {
    int want = total - received;
    if (want > (int)sizeof(buf) - 1) want = sizeof(buf) - 1;
    int got = httpd_req_recv(req, buf, want);
    if (got <= 0) return false;
    buf[got] = '\0';
    out += buf;
    received += got;
  }
  return true;
}

esp_err_t sendJson(httpd_req_t *req, const char *status, const String &json) {
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, json.c_str(), json.length());
}

esp_err_t sendError(httpd_req_t *req, const char *status, const char *message) {
  String body = "{\"error\":\"" + jsonEscape(String(message)) + "\"}";
  return sendJson(req, status, body);
}

} // namespace httputil
