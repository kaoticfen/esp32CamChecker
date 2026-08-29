import type { Camera } from '../api.ts';
import { api, snapshotSrc } from '../api.ts';
import { el, formatRelative } from '../dom.ts';
import { bar, clearError, errorBox, showError, spinner } from '../shell.ts';

const LIST_REFRESH_MS = 10_000;
const THUMB_REFRESH_MS = 5_000;

/**
 * Keeps one tile's thumbnail current.
 *
 * A tile only polls while it is actually on screen and the tab is in the
 * foreground, and the next request is scheduled from the previous one settling
 * rather than on a fixed timer -- otherwise a slow camera accumulates a queue
 * of overlapping snapshot requests that it can never work through.
 */
class Thumbnail {
  #img: HTMLImageElement;
  #id: string;
  #timer: number | null = null;
  #visible = false;
  #stopped = false;

  constructor(img: HTMLImageElement, id: string) {
    this.#img = img;
    this.#id = id;
    const schedule = () => this.#schedule();
    img.addEventListener('load', schedule);
    img.addEventListener('error', schedule);
  }

  setVisible(visible: boolean): void {
    const wasVisible = this.#visible;
    this.#visible = visible;
    if (visible && !wasVisible) this.#load();
  }

  wake(): void {
    if (this.#visible && this.#timer === null) this.#load();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    // Cancels an in-flight image request instead of letting it complete.
    this.#img.removeAttribute('src');
  }

  #load(): void {
    if (this.#stopped || !this.#visible || document.hidden) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#img.src = snapshotSrc(this.#id);
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#load();
    }, THUMB_REFRESH_MS);
  }
}

function tile(camera: Camera, register: (img: HTMLImageElement, id: string) => void): HTMLElement {
  const img = el('img', { attrs: { alt: `Latest frame from ${camera.name}`, decoding: 'async' } });
  const thumb = el('div', { class: 'thumb' });

  if (camera.online) {
    register(img, camera.id);
    thumb.append(img);
  } else {
    thumb.append(
      el('div', {
        class: 'placeholder',
        text: `Offline · last seen ${formatRelative(camera.lastSeen)}`,
      }),
    );
  }

  return el(
    'a',
    { class: 'tile', href: `#/cam/${encodeURIComponent(camera.id)}` },
    thumb,
    el(
      'div',
      { class: 'meta' },
      el('span', { class: camera.online ? 'dot on' : 'dot' }),
      el('span', { class: 'name', text: camera.name }),
      camera.viewers > 0 ? el('span', { class: 'muted', text: `${camera.viewers} watching` }) : null,
    ),
  );
}

export function renderGrid(root: HTMLElement): () => void {
  const error = errorBox();
  const body = el('div', {}, spinner('Loading cameras'));

  const addButton = el('a', { class: 'btn primary', href: '#/add', text: '+ Add' });
  const logoutButton = el('button', {
    class: 'icon',
    text: 'Sign out',
    onclick: () => {
      void api.logout().then(() => window.dispatchEvent(new CustomEvent('hub:unauthorized')));
    },
  });

  root.replaceChildren(bar('Cameras', addButton, logoutButton), error, body);

  const thumbnails = new Map<HTMLImageElement, Thumbnail>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const thumb = thumbnails.get(entry.target as HTMLImageElement);
        thumb?.setVisible(entry.isIntersecting);
      }
    },
    { rootMargin: '150px' },
  );

  const register = (img: HTMLImageElement, id: string): void => {
    thumbnails.set(img, new Thumbnail(img, id));
    observer.observe(img);
  };

  const clearThumbnails = (): void => {
    for (const thumb of thumbnails.values()) thumb.stop();
    thumbnails.clear();
    observer.disconnect();
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) return;
    for (const thumb of thumbnails.values()) thumb.wake();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  let stopped = false;

  const load = async (): Promise<void> => {
    try {
      const { cameras } = await api.cameras();
      if (stopped) return;
      clearError(error);
      clearThumbnails();

      if (cameras.length === 0) {
        body.replaceChildren(
          el(
            'div',
            { class: 'card pad empty' },
            el('p', { text: 'No cameras yet.' }),
            el('a', { class: 'btn primary', href: '#/add', text: 'Add your first camera' }),
          ),
        );
        return;
      }

      body.replaceChildren(
        el('div', { class: 'grid' }, ...cameras.map((camera) => tile(camera, register))),
      );
    } catch (err) {
      if (stopped) return;
      showError(error, err);
      body.replaceChildren();
    }
  };

  void load();
  const timer = window.setInterval(() => void load(), LIST_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearThumbnails();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
