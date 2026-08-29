#pragma once

// ---------------------------------------------------------------------------
// AI Thinker ESP32-CAM pin map (OV2640)
// ---------------------------------------------------------------------------
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// Bright white flash LED. Free to use because the SD card runs in 1-bit mode
// (4-bit mode would claim this pin as SD data line 1).
#define FLASH_LED_PIN 4
// Small red status LED on the underside of the board. Active LOW.
#define STATUS_LED_PIN 33

// This board exposes no user button -- GPIO0 is the camera XCLK, and holding
// it low at reset drops the chip into the ROM bootloader instead of running
// our code. So the physical escape hatch is a reset count: tap RESET three
// times in quick succession to wipe the camera back to the setup portal.
#define FACTORY_RESET_BOOT_COUNT 3
#define BOOT_COUNT_CLEAR_MS 6000

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
#define CONTROL_PORT 80
#define STREAM_PORT 81

// Password for the setup access point the camera raises when it has no Wi-Fi
// credentials. This only ever protects the provisioning window, never the
// camera itself -- see docs/SECURITY.md.
#define SETUP_AP_PASSWORD "plantcam-setup"
#define SETUP_AP_PREFIX "esp32cam-setup-"
#define CONFIG_PORTAL_TIMEOUT_S 300

#define WIFI_CONNECT_TIMEOUT_S 20
#define HEARTBEAT_INTERVAL_MS 30000
#define PAIR_RETRY_INTERVAL_MS 15000

#define NTP_SERVER "pool.ntp.org"

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
#define SD_MOUNT_POINT "/sdcard"
#define CAPTURE_ROOT "/DCIM"
#define MAX_SD_LIST_ENTRIES 250
#define SD_CHUNK_SIZE 4096

#ifndef FW_VERSION
#define FW_VERSION "0.0.0-dev"
#endif
