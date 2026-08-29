#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>
#include <time.h>

#include "camera.h"
#include "config.h"
#include "http_api.h"
#include "pairing.h"
#include "sdcard.h"
#include "storage.h"
#include "stream_server.h"
#include "wifi_provision.h"

namespace {

bool bootCountCleared = false;
uint32_t wifiDownSince = 0;
uint32_t lastReconnectAttempt = 0;

void setStatusLed(bool on) {
  digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH); // active low
}

// Tapping RESET three times in a row wipes the camera. Only count resets that a
// human could have caused: this board browns out and panics often enough that
// counting *every* reboot would eventually erase a healthy camera on its own.
void checkFactoryResetGesture() {
  esp_reset_reason_t reason = esp_reset_reason();
  if (reason != ESP_RST_POWERON && reason != ESP_RST_EXT) {
    storage::clearBootCount();
    return;
  }

  int boots = storage::noteBoot();
  Serial.printf("[boot] reset tap %d/%d\n", boots, FACTORY_RESET_BOOT_COUNT);
  if (boots >= FACTORY_RESET_BOOT_COUNT) {
    Serial.println("[boot] factory reset gesture detected");
    storage::factoryReset(); // reboots
  }
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiDownSince = 0;
    return;
  }

  uint32_t now = millis();
  if (wifiDownSince == 0) {
    wifiDownSince = now;
    Serial.println("[wifi] link lost");
  }
  if (now - lastReconnectAttempt >= 10000) {
    lastReconnectAttempt = now;
    WiFi.reconnect();
  }
  // Five minutes of no Wi-Fi means something is wrong that a reboot has a
  // better chance of fixing than another reconnect.
  if (now - wifiDownSince > 300000) {
    Serial.println("[wifi] down too long, restarting");
    ESP.restart();
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[boot] esp32CamChecker firmware %s\n", FW_VERSION);

  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  storage::begin();
  checkFactoryResetGesture();

  if (!camera::begin()) {
    Serial.println("[boot] camera init failed, restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  // A missing card is not fatal -- live view still works, only the SD browser
  // and captures are unavailable.
  sdcard::begin();

  if (!wifiprov::begin()) {
    Serial.println("[boot] no Wi-Fi and the setup portal timed out, restarting");
    delay(2000);
    ESP.restart();
  }

  Serial.printf("[wifi] connected to \"%s\" as %s\n", WiFi.SSID().c_str(),
                WiFi.localIP().toString().c_str());
  Serial.printf("[boot] device id %s\n", storage::deviceId().c_str());

  // UTC; the hub renders timestamps in the viewer's local zone.
  configTime(0, 0, NTP_SERVER);

  httpapi::begin();
  streamserver::begin();

  if (!storage::isPaired()) {
    Serial.println("[boot] not paired yet -- will claim its code on the next loop");
  }
  setStatusLed(true);
}

void loop() {
  if (!bootCountCleared && millis() > BOOT_COUNT_CLEAR_MS) {
    storage::clearBootCount();
    bootCountCleared = true;
  }

  maintainWifi();
  pairing::loop();
  delay(200);
}
