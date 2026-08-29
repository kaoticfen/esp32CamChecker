#include "pairing.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include "config.h"
#include "sdcard.h"
#include "storage.h"

namespace {

uint32_t lastPairAttempt = 0;
uint32_t lastHeartbeat = 0;
int consecutiveUnauthorized = 0;

// One transient 401 could be a hub restarting mid-write. Three in a row means
// the hub really has revoked us, and the only way back is the setup portal.
const int kRevokeThreshold = 3;

bool attemptPair() {
  String code = storage::pairingCode();
  String hub = storage::hubUrl();
  if (code.isEmpty() || hub.isEmpty()) return false;

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(hub + "/api/pair")) {
    Serial.println("[pair] bad hub URL");
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  JsonDocument doc;
  doc["code"] = code;
  doc["deviceId"] = storage::deviceId();
  doc["name"] = storage::name();
  doc["fwVersion"] = FW_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["controlPort"] = CONTROL_PORT;
  doc["streamPort"] = STREAM_PORT;

  String body;
  serializeJson(doc, body);

  int status = http.POST(body);
  String response = http.getString();
  http.end();

  if (status == 200) {
    JsonDocument reply;
    if (deserializeJson(reply, response) == DeserializationError::Ok) {
      const char *token = reply["token"];
      if (token && strlen(token) >= 32) {
        storage::setToken(token);
        const char *name = reply["name"];
        if (name && strlen(name)) storage::setName(name);
        storage::clearPairingCode();
        Serial.println("[pair] paired with hub");
        return true;
      }
    }
    Serial.println("[pair] hub returned 200 without a usable token");
    return false;
  }

  Serial.printf("[pair] hub rejected pairing: HTTP %d %s\n", status, response.c_str());
  if (status >= 400 && status < 500) {
    // Wrong, expired, or already-claimed code. Retrying will never succeed, so
    // stop burning the radio and wait for a re-provision.
    storage::clearPairingCode();
  }
  return false;
}

void sendHeartbeat() {
  String hub = storage::hubUrl();
  String token = storage::token();
  if (hub.isEmpty() || token.isEmpty()) return;

  HTTPClient http;
  http.setTimeout(6000);
  String url = hub + "/api/devices/" + storage::deviceId() + "/heartbeat";
  if (!http.begin(url)) return;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + token);

  JsonDocument doc;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptimeMs"] = (uint32_t)millis();
  doc["fwVersion"] = FW_VERSION;
  doc["name"] = storage::name();
  doc["controlPort"] = CONTROL_PORT;
  doc["streamPort"] = STREAM_PORT;
  doc["heapFree"] = (uint32_t)ESP.getFreeHeap();
  doc["sdMounted"] = sdcard::mounted();
  doc["sdTotalKb"] = (uint32_t)(sdcard::totalBytes() / 1024);
  doc["sdUsedKb"] = (uint32_t)(sdcard::usedBytes() / 1024);

  String body;
  serializeJson(doc, body);

  int status = http.POST(body);
  http.end();

  if (status == 401 || status == 403) {
    consecutiveUnauthorized++;
    Serial.printf("[hb] hub rejected our token (%d/%d)\n", consecutiveUnauthorized,
                  kRevokeThreshold);
    if (consecutiveUnauthorized >= kRevokeThreshold) {
      Serial.println("[hb] token revoked, returning to setup portal");
      storage::factoryReset(); // reboots
    }
  } else if (status > 0) {
    consecutiveUnauthorized = 0;
  }
}

} // namespace

namespace pairing {

void loop() {
  if (WiFi.status() != WL_CONNECTED) return;
  uint32_t now = millis();

  if (!storage::isPaired()) {
    if (now - lastPairAttempt >= PAIR_RETRY_INTERVAL_MS || lastPairAttempt == 0) {
      lastPairAttempt = now;
      attemptPair();
    }
    return;
  }

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS || lastHeartbeat == 0) {
    lastHeartbeat = now;
    sendHeartbeat();
  }
}

} // namespace pairing
