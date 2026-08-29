import { api } from '../api.ts';
import { el } from '../dom.ts';
import { backButton, clearError, errorBox, showError, spinner } from '../shell.ts';

function countdown(expiresAt: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  if (seconds === 0) return 'expired';
  const minutes = Math.floor(seconds / 60);
  return `expires in ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function renderAdd(root: HTMLElement): () => void {
  const error = errorBox();
  const body = el('div', { class: 'card pad' }, spinner('Creating a pairing code'));

  const header = el('header', { class: 'bar' }, backButton('#/'), el('h1', { text: 'Add a camera' }));
  root.replaceChildren(header, error, body);

  let stopped = false;
  let timer: number | null = null;

  const load = async (): Promise<void> => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    try {
      const minted = await api.newPairingCode();
      if (stopped) return;
      clearError(error);

      const expiry = el('p', { class: 'muted', text: countdown(minted.expiresAt) });
      const again = el('button', { text: 'New code' });
      again.onclick = () => {
        body.replaceChildren(spinner('Creating a pairing code'));
        void load();
      };

      body.replaceChildren(
        el('div', { class: 'code', text: minted.display }),
        expiry,
        el(
          'ol',
          { class: 'steps' },
          el('li', {}, 'Flash the firmware with the ESP32-CAM-MB shield: ', el('code', { text: 'pio run -e cam -t upload' })),
          el('li', {}, 'Power the camera. It raises a Wi-Fi network called ', el('strong', { text: 'esp32cam-setup-xxxxxx' }), '.'),
          el('li', {}, 'Join that network from this phone. The password is ', el('code', { text: 'plantcam-setup' }), '.'),
          el('li', {}, 'The setup page opens automatically. Pick your home Wi-Fi and enter its password.'),
          el('li', {}, 'Enter this hub’s address, the pairing code above, and a name for the camera.'),
          el('li', {}, 'Save. The camera reboots, joins your Wi-Fi, claims the code, and appears on the Cameras page within about a minute.'),
        ),
        el('p', {
          class: 'muted',
          text: 'The code works once and only until it expires. Generate a new one for each camera.',
        }),
        el('div', { class: 'row' }, again, el('a', { class: 'btn', href: '#/', text: 'Done' })),
      );

      timer = window.setInterval(() => {
        expiry.textContent = countdown(minted.expiresAt);
        if (minted.expiresAt <= Date.now() && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }, 1000);
    } catch (err) {
      if (stopped) return;
      showError(error, err);
      body.replaceChildren(
        el('button', { class: 'primary', text: 'Try again', onclick: () => void load() }),
      );
    }
  };

  void load();

  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}
