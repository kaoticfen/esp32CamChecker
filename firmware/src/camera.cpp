#include "camera.h"

#include "config.h"

namespace {
bool psramAvailable = false;
bool flashState = false;
} // namespace

namespace camera {

bool hasPsram() { return psramAvailable; }

bool begin() {
  psramAvailable = psramFound();

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;
  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;
  cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;

  // Without PSRAM the frame buffer lives in the ~160KB of usable DRAM, which
  // caps us well below UXGA and leaves room for exactly one buffer.
  if (psramAvailable) {
    cfg.frame_size = FRAMESIZE_UXGA;
    cfg.jpeg_quality = 10;
    cfg.fb_count = 2;
    cfg.fb_location = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    cfg.frame_size = FRAMESIZE_SVGA;
    cfg.jpeg_quality = 14;
    cfg.fb_count = 1;
    cfg.fb_location = CAMERA_FB_IN_DRAM;
    cfg.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("[camera] init failed: 0x%x\n", err);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    // The OV2640 on these boards ships upside down relative to how the module
    // is usually mounted, and its stock saturation is washed out.
    s->set_vflip(s, 1);
    s->set_hmirror(s, 0);
    s->set_brightness(s, 1);
    s->set_saturation(s, -1);
    // Start streams at a size the Wi-Fi radio can actually keep up with; the
    // hub can raise it per camera.
    s->set_framesize(s, psramAvailable ? FRAMESIZE_VGA : FRAMESIZE_SVGA);
  }

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  Serial.printf("[camera] ready (psram=%s)\n", psramAvailable ? "yes" : "no");
  return true;
}

bool applySetting(const String &key, int value) {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return false;

  if (key == "framesize") {
    if (value < 0 || value > FRAMESIZE_UXGA) return false;
    if (!psramAvailable && value > FRAMESIZE_SVGA) value = FRAMESIZE_SVGA;
    return s->set_framesize(s, (framesize_t)value) == 0;
  }
  if (key == "quality") {
    if (value < 4 || value > 63) return false;
    return s->set_quality(s, value) == 0;
  }
  if (key == "brightness") return s->set_brightness(s, value) == 0;
  if (key == "contrast") return s->set_contrast(s, value) == 0;
  if (key == "saturation") return s->set_saturation(s, value) == 0;
  if (key == "hmirror") return s->set_hmirror(s, value ? 1 : 0) == 0;
  if (key == "vflip") return s->set_vflip(s, value ? 1 : 0) == 0;
  if (key == "flash") {
    setFlash(value != 0);
    return true;
  }
  return false;
}

String settingsJson() {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return String("{}");

  String out = "{";
  out += "\"framesize\":" + String((int)s->status.framesize);
  out += ",\"quality\":" + String((int)s->status.quality);
  out += ",\"brightness\":" + String((int)s->status.brightness);
  out += ",\"contrast\":" + String((int)s->status.contrast);
  out += ",\"saturation\":" + String((int)s->status.saturation);
  out += ",\"hmirror\":" + String((int)s->status.hmirror);
  out += ",\"vflip\":" + String((int)s->status.vflip);
  out += ",\"flash\":" + String(flashState ? 1 : 0);
  out += "}";
  return out;
}

void setFlash(bool on) {
  flashState = on;
  digitalWrite(FLASH_LED_PIN, on ? HIGH : LOW);
}

bool flashOn() { return flashState; }

} // namespace camera
