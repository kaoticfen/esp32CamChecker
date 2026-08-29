#pragma once

#include <esp_http_server.h>

namespace auth {

// True when the request carries `Authorization: Bearer <device token>`.
// An unpaired camera has no token and therefore rejects everything.
bool check(httpd_req_t *req);

esp_err_t reject(httpd_req_t *req);

} // namespace auth
