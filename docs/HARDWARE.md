# Hardware notes

This is helpful https://randomnerdtutorials.com/program-upload-code-esp32-cam/ 

Everything here is specific to the **AI-Thinker ESP32-CAM** with the
**ESP32-CAM-MB** programmer shield. Other ESP32 camera boards use different
pins; `firmware/include/config.h` is where you would change them.

## Flashing

The MB shield carries a CH340 USB-serial chip wired to EN and IO0, so it
handles the reset-and-bootload dance itself. **No IO0 jumper, no button
presses.**

```bash
cd firmware
pio run -e cam -t upload
pio device monitor
```

On macOS the board appears as `/dev/cu.usbserial-*`. If nothing shows up,
install the CH340 driver and re-plug.

## Power

The single most common cause of "my ESP32-CAM randomly reboots" is power. The
OV2640 pulls hard the moment a frame is captured, and a thin USB cable or a
weak port browns the board out mid-capture.

- Use a supply rated **1A or better** and a short, thick cable.
- If you power the 5V pin directly, keep the wiring short.
- A 470µF electrolytic across 5V/GND on a breadboard build removes most of the
  remaining instability.

The firmware treats a brownout as a real event rather than papering over it:
`checkFactoryResetGesture()` in `firmware/src/main.cpp` deliberately ignores
brownout and panic resets, so a flapping power supply can never trip the
factory-reset gesture and wipe a working camera.

## SD card

The card is mounted in **1-bit mode**, which is not a performance compromise
you can opt out of on this board:

- 4-bit mode claims **GPIO4**, which is also the flash LED.
- 4-bit mode claims **GPIO12**, a boot strapping pin. A card that holds it high
  at reset stops the board from booting at all.

1-bit mode uses only CLK (GPIO14), CMD (GPIO15) and D0 (GPIO2), which leaves the
flash LED usable while the card is mounted.

Format cards as **FAT32**. Large cards work, but the listing endpoint caps a
single directory at 250 entries (`MAX_SD_LIST_ENTRIES`), so keep captures in
dated subfolders — which is what `/DCIM/YYYYMMDD/` does automatically.

A missing or unreadable card is not fatal. Live view still works; only captures
and the SD browser are unavailable, and `/api/info` reports `sd.mounted: false`.

## Pins already spoken for

| GPIO | Used by | Note |
|---|---|---|
| 0 | Camera XCLK | Also the bootloader strap — cannot be a user button |
| 2, 14, 15 | SD_MMC (1-bit) | |
| 4 | Flash LED | Very bright; also SD D1 in 4-bit mode |
| 12, 13 | Free in 1-bit mode | GPIO12 is a strapping pin — leave it floating at boot |
| 33 | Onboard red LED | Active **low**; used as the ready indicator |
| 5, 18, 19, 21–27, 32, 34–36, 39 | Camera data/control | |

Because GPIO0 is the camera clock, there is no spare button for a factory
reset. The firmware uses a **reset-tap gesture** instead: press RESET three
times within about six seconds of each other and the camera wipes its Wi-Fi
credentials and hub token, then reopens the setup portal.

## Wi-Fi range

The onboard PCB antenna is mediocre. Boards with a U.FL connector need the
0-ohm resistor next to it moved to select the external antenna — if you attach
an antenna without moving it, range gets *worse*, not better. Check the RSSI on
the camera detail page: below about −75 dBm the stream will stutter.
