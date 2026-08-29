#pragma once

#include <esp_http_server.h>

namespace ota {

// POST /api/ota with the raw .bin body and a valid device token. Registered by
// http_api so it shares the control server's auth and port.
esp_err_t handler(httpd_req_t *req);

} // namespace ota
