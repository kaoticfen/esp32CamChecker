#include "wifi_provision.h"

#include <WiFi.h>
#include <WiFiManager.h>

#include "config.h"
#include "storage.h"

namespace {

String trimmed(const char *value) {
  String s(value ? value : "");
  s.trim();
  return s;
}

// Accepts "http://host", "http://host:port" and bare "host[:port]", and
// normalises to a scheme-qualified URL with no trailing slash.
String normaliseHubUrl(const String &raw) {
  String url = raw;
  if (url.isEmpty()) return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "http://" + url;
  }
  while (url.endsWith("/")) url.remove(url.length() - 1);
  return url;
}

} // namespace

namespace wifiprov {

String apName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[40];
  snprintf(buf, sizeof(buf), SETUP_AP_PREFIX "%02x%02x%02x", mac[3], mac[4], mac[5]);
  return String(buf);
}

bool begin() {
  WiFi.mode(WIFI_STA);

  WiFiManager wm;
  wm.setDebugOutput(false);
  wm.setTitle("ESP32-CAM setup");
  wm.setConnectTimeout(WIFI_CONNECT_TIMEOUT_S);
  wm.setConfigPortalTimeout(CONFIG_PORTAL_TIMEOUT_S);

  String hubDefault = storage::hubUrl();
  String nameDefault = storage::name();

  WiFiManagerParameter hubParam("hub", "Hub URL (e.g. 192.168.1.50:8080)",
                                hubDefault.c_str(), 80);
  WiFiManagerParameter codeParam("code", "Pairing code from the hub", "", 24);
  WiFiManagerParameter nameParam("name", "Camera name (e.g. Greenhouse)",
                                 nameDefault.c_str(), 32);
  wm.addParameter(&hubParam);
  wm.addParameter(&codeParam);
  wm.addParameter(&nameParam);
  // setMenu takes a non-const reference, so the vector needs to outlive the call.
  std::vector<const char *> menu{"wifi", "info", "restart"};
  wm.setMenu(menu);

  bool paramsSubmitted = false;
  wm.setSaveParamsCallback([&paramsSubmitted]() { paramsSubmitted = true; });

  String ap = apName();
  Serial.printf("[wifi] connecting, setup AP is \"%s\"\n", ap.c_str());

  bool connected = wm.autoConnect(ap.c_str(), SETUP_AP_PASSWORD);

  if (paramsSubmitted) {
    String hub = normaliseHubUrl(trimmed(hubParam.getValue()));
    String code = trimmed(codeParam.getValue());
    String name = trimmed(nameParam.getValue());

    if (hub.length()) storage::setHubUrl(hub);
    if (name.length()) storage::setName(name);
    if (code.length()) {
      // A freshly entered pairing code means this camera is being (re-)claimed,
      // so any token it still holds is stale.
      storage::setPairingCode(code);
      storage::setToken("");
    }
    Serial.printf("[wifi] provisioned hub=%s name=%s code=%s\n", hub.c_str(), name.c_str(),
                  code.length() ? "yes" : "no");
  }

  return connected;
}

} // namespace wifiprov
