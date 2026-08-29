#include "storage.h"

#include <Preferences.h>
#include <WiFi.h>

#include "config.h"

namespace {
Preferences prefs;
const char *kNamespace = "camcfg";
} // namespace

namespace storage {

void begin() { prefs.begin(kNamespace, false); }

String hubUrl() { return prefs.getString("hub", ""); }
void setHubUrl(const String &url) { prefs.putString("hub", url); }

String token() { return prefs.getString("token", ""); }
void setToken(const String &token) { prefs.putString("token", token); }

String name() { return prefs.getString("name", ""); }
void setName(const String &name) { prefs.putString("name", name); }

String pairingCode() { return prefs.getString("code", ""); }
void setPairingCode(const String &code) { prefs.putString("code", code); }
void clearPairingCode() { prefs.remove("code"); }

String deviceId() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[20];
  snprintf(buf, sizeof(buf), "cam-%02x%02x%02x%02x%02x%02x", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

bool isPaired() { return token().length() > 0 && hubUrl().length() > 0; }

int noteBoot() {
  int count = prefs.getInt("bootcnt", 0) + 1;
  prefs.putInt("bootcnt", count);
  return count;
}

void clearBootCount() { prefs.putInt("bootcnt", 0); }

void factoryReset() {
  Serial.println("[storage] factory reset");
  prefs.clear();
  WiFi.disconnect(true, true); // also erases the stored Wi-Fi config
  delay(500);
  ESP.restart();
}

} // namespace storage
