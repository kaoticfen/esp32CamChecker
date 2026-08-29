import type { CameraInfo } from '../api.ts';
import { api, streamSrc } from '../api.ts';
import { el, formatBytes } from '../dom.ts';
import { backButton, bar, clearError, errorBox, showError, spinner } from '../shell.ts';

/** framesize_t values from esp32-camera, trimmed to the useful range. */
const RESOLUTIONS: Array<{ value: number; label: string }> = [
  { value: 5, label: 'QVGA 320×240' },
  { value: 8, label: 'VGA 640×480' },
  { value: 9, label: 'SVGA 800×600' },
  { value: 10, label: 'XGA 1024×768' },
  { value: 11, label: 'HD 1280×720' },
  { value: 13, label: 'UXGA 1600×1200' },
];

const INFO_REFRESH_MS = 15_000;
const STREAM_RETRY_MS = 3_000;

function stat(key: string, value: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k', text: key }), el('div', { class: 'v', text: value }));
}

export function renderCamera(root: HTMLElement, id: string): () => void {
  const error = errorBox();
  const title = el('h1', { text: 'Camera' });

  const img = el('img', { attrs: { alt: 'Live view' } });
  const viewer = el('div', { class: 'viewer' }, img);
  const controls = el('div', {});
  const details = el('div', {}, spinner('Loading camera'));

  const header = el('header', { class: 'bar' }, backButton('#/'), title);
  root.replaceChildren(header, error, viewer, controls, details);

  let stopped = false;
  let retryTimer: number | null = null;

  const openStream = (): void => {
    if (stopped) return;
    img.src = streamSrc(id);
  };

  // An MJPEG <img> reports a dropped connection as a load error. Retrying keeps
  // the view alive across a camera reboot or a brief Wi-Fi drop.
  img.addEventListener('error', () => {
    if (stopped || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      openStream();
    }, STREAM_RETRY_MS);
  });
  openStream();

  const busy = async (button: HTMLButtonElement, label: string, run: () => Promise<unknown>) => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      clearError(error);
      await run();
    } catch (err) {
      showError(error, err);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };

  const buildControls = (info: CameraInfo): void => {
    const resolution = el('select', {
      onchange: (event) => {
        const select = event.target as HTMLSelectElement;
        void api
          .settings(id, { framesize: Number(select.value) })
          .then(() => clearError(error))
          .catch((err: unknown) => showError(error, err));
      },
    });
    for (const option of RESOLUTIONS) {
      const node = el('option', { value: String(option.value), text: option.label });
      if (option.value === info.settings.framesize) node.selected = true;
      resolution.append(node);
    }

    const toggle = (
      label: string,
      key: 'flash' | 'hmirror' | 'vflip',
      initial: number,
    ): HTMLButtonElement => {
      let state = initial !== 0;
      const button = el('button', { text: `${label}: ${state ? 'on' : 'off'}` });
      button.onclick = () => {
        void busy(button, '…', async () => {
          await api.settings(id, { [key]: state ? 0 : 1 });
          state = !state;
          button.textContent = `${label}: ${state ? 'on' : 'off'}`;
        });
      };
      return button;
    };

    const captureButton = el('button', { class: 'primary', text: 'Capture to SD' });
    captureButton.onclick = () => {
      void busy(captureButton, 'Capturing…', async () => {
        const result = await api.capture(id);
        captureButton.textContent = 'Saved';
        window.setTimeout(() => (captureButton.textContent = 'Capture to SD'), 1500);
        details.dispatchEvent(new CustomEvent('captured', { detail: result.path }));
      });
    };

    const rebootButton = el('button', { text: 'Reboot' });
    rebootButton.onclick = () => {
      if (!window.confirm('Reboot this camera?')) return;
      void busy(rebootButton, 'Rebooting…', () => api.reboot(id));
    };

    const nameInput = el('input', { type: 'text', value: info.name, placeholder: 'Camera name' });
    const saveName = el('button', { text: 'Rename' });
    saveName.onclick = () => {
      void busy(saveName, 'Saving…', async () => {
        await api.rename(id, nameInput.value.trim());
        title.textContent = nameInput.value.trim();
      });
    };

    const removeButton = el('button', { class: 'danger', text: 'Remove camera' });
    removeButton.onclick = () => {
      if (
        !window.confirm(
          'Remove this camera from the hub?\n\n' +
            'It will notice its token no longer works and reset itself back to the setup portal.',
        )
      ) {
        return;
      }
      void busy(removeButton, 'Removing…', async () => {
        await api.remove(id);
        window.location.hash = '#/';
      });
    };

    controls.replaceChildren(
      el(
        'div',
        { class: 'row' },
        captureButton,
        el('a', {
          class: 'btn',
          href: `#/cam/${encodeURIComponent(id)}/sd`,
          text: 'Browse SD card',
        }),
        toggle('Flash', 'flash', info.settings.flash),
      ),
      el(
        'div',
        { class: 'card pad', attrs: { style: 'margin-top:14px' } },
        el('div', { class: 'field' }, el('label', { text: 'Resolution' }), resolution),
        el('div', { class: 'field' }, el('label', { text: 'Name' }), nameInput),
        el('div', { class: 'row' }, saveName, toggle('Mirror', 'hmirror', info.settings.hmirror), toggle('Flip', 'vflip', info.settings.vflip)),
        el('div', { class: 'row' }, rebootButton, removeButton),
      ),
    );
  };

  let controlsBuilt = false;

  const loadInfo = async (): Promise<void> => {
    try {
      const info = await api.cameraInfo(id);
      if (stopped) return;
      clearError(error);
      title.textContent = info.name || info.deviceId;

      if (!controlsBuilt) {
        // Built once: rebuilding on every poll would fight the user mid-edit.
        buildControls(info);
        controlsBuilt = true;
      }

      const uptimeMinutes = Math.floor(info.uptimeMs / 60000);
      details.replaceChildren(
        el(
          'div',
          { class: 'stats' },
          stat('Signal', `${info.rssi} dBm`),
          stat('Uptime', uptimeMinutes < 60 ? `${uptimeMinutes}m` : `${Math.floor(uptimeMinutes / 60)}h`),
          stat('Firmware', info.fwVersion),
          stat('Free heap', formatBytes(info.heapFree)),
          stat('PSRAM', info.psram ? 'yes' : 'no'),
          stat(
            'SD card',
            info.sd.mounted
              ? `${formatBytes(info.sd.usedKb * 1024)} / ${formatBytes(info.sd.totalKb * 1024)}`
              : 'not mounted',
          ),
        ),
        el('p', { class: 'muted', text: `${info.deviceId} · ${info.ip}` }),
      );
    } catch (err) {
      if (stopped) return;
      showError(error, err);
      details.replaceChildren();
    }
  };

  void loadInfo();
  const timer = window.setInterval(() => void loadInfo(), INFO_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    // Dropping the src is what actually closes the MJPEG connection, which is
    // what lets the hub release its upstream connection to the camera.
    img.removeAttribute('src');
  };
}
