import type { SdEntry } from '../api.ts';
import { api, fileSrc } from '../api.ts';
import { el, formatBytes, formatFileTime } from '../dom.ts';
import { backButton, clearError, errorBox, showError, spinner } from '../shell.ts';

const IMAGE_PATTERN = /\.(jpe?g|png|gif)$/i;

function sdHref(id: string, path: string): string {
  return `#/cam/${encodeURIComponent(id)}/sd?path=${encodeURIComponent(path)}`;
}

function openLightbox(src: string, alt: string): void {
  const image = el('img', { src, attrs: { alt } });
  const close = el('button', { class: 'close', text: 'Close' });
  const overlay = el('div', { class: 'lightbox' }, image, close);

  const dismiss = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss();
  };

  close.onclick = dismiss;
  overlay.onclick = (event) => {
    // Clicking the image itself should not dismiss -- people pinch and pan it.
    if (event.target === overlay) dismiss();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  close.focus();
}

export function renderSd(root: HTMLElement, id: string, path: string): () => void {
  const error = errorBox();
  const crumbs = el('div', { class: 'crumbs' });
  const body = el('div', { class: 'card' }, spinner('Reading card'));

  const header = el(
    'header',
    { class: 'bar' },
    backButton(`#/cam/${encodeURIComponent(id)}`, 'Back to camera'),
    el('h1', { text: 'SD card' }),
  );
  root.replaceChildren(header, error, crumbs, body);

  let stopped = false;

  const buildCrumbs = (current: string): void => {
    const parts = current.split('/').filter(Boolean);
    const nodes: Array<Node | string> = [el('a', { href: sdHref(id, '/'), text: 'card' })];
    let accumulated = '';
    for (const part of parts) {
      accumulated += `/${part}`;
      nodes.push(' / ', el('a', { href: sdHref(id, accumulated), text: part }));
    }
    crumbs.replaceChildren(...nodes);
  };

  const row = (entry: SdEntry, reload: () => void): HTMLElement => {
    const subtitle = entry.dir
      ? formatFileTime(entry.mtime)
      : [formatBytes(entry.size), formatFileTime(entry.mtime)].filter(Boolean).join(' · ');

    const label = entry.dir
      ? el('a', { href: sdHref(id, entry.path), text: entry.name })
      : IMAGE_PATTERN.test(entry.name)
        ? el('button', {
            class: 'link',
            text: entry.name,
            onclick: () => openLightbox(fileSrc(id, entry.path), entry.name),
          })
        : el('a', { href: fileSrc(id, entry.path), text: entry.name, attrs: { target: '_blank' } });

    const actions: Array<Node> = [];
    if (!entry.dir) {
      actions.push(
        el('a', {
          class: 'btn icon',
          href: fileSrc(id, entry.path, true),
          download: entry.name,
          title: 'Download',
          attrs: { 'aria-label': `Download ${entry.name}` },
        }, '⬇'),
      );
    }

    const remove = el('button', {
      class: 'icon danger',
      text: '✕',
      title: 'Delete',
      attrs: { 'aria-label': `Delete ${entry.name}` },
    });
    remove.onclick = () => {
      if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
      remove.disabled = true;
      void api
        .sdDelete(id, entry.path)
        .then(reload)
        .catch((err: unknown) => {
          showError(error, err);
          remove.disabled = false;
        });
    };
    actions.push(remove);

    return el(
      'li',
      {},
      el('span', { class: 'glyph', text: entry.dir ? '📁' : IMAGE_PATTERN.test(entry.name) ? '🖼' : '📄' }),
      el('div', { class: 'info' }, label, subtitle ? el('div', { class: 'sub', text: subtitle }) : null),
      ...actions,
    );
  };

  const load = async (): Promise<void> => {
    try {
      const listing = await api.sdList(id, path);
      if (stopped) return;
      clearError(error);
      buildCrumbs(listing.path);

      if (listing.entries.length === 0) {
        body.replaceChildren(el('div', { class: 'empty', text: 'This folder is empty.' }));
        return;
      }

      // Directories first, then newest files -- the useful order when you are
      // looking for the photo you just took.
      const entries = [...listing.entries].sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (a.dir) return a.name.localeCompare(b.name);
        return b.mtime - a.mtime || a.name.localeCompare(b.name);
      });

      const list = el('ul', { class: 'files' }, ...entries.map((entry) => row(entry, () => void load())));
      body.replaceChildren(list);

      if (listing.truncated) {
        body.append(
          el('div', {
            class: 'empty muted',
            text: 'Only the first 250 entries are shown. Open a subfolder to see the rest.',
          }),
        );
      }
    } catch (err) {
      if (stopped) return;
      showError(error, err);
      body.replaceChildren();
    }
  };

  void load();

  return () => {
    stopped = true;
    document.querySelector('.lightbox')?.remove();
  };
}
