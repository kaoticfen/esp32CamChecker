import type { Child } from './dom.ts';
import { el } from './dom.ts';

export function bar(title: string, ...actions: Child[]): HTMLElement {
  return el('header', { class: 'bar' }, el('h1', { text: title }), ...actions);
}

export function backButton(href: string, label = 'Back'): HTMLElement {
  return el('a', { class: 'btn icon', href, title: label, attrs: { 'aria-label': label } }, '←');
}

export function errorBox(): HTMLDivElement {
  return el('div', { class: 'error', hidden: true, attrs: { role: 'alert' } });
}

export function showError(box: HTMLElement, error: unknown): void {
  box.textContent = error instanceof Error ? error.message : String(error);
  box.hidden = false;
}

export function clearError(box: HTMLElement): void {
  box.hidden = true;
  box.textContent = '';
}

export function spinner(label = 'Loading'): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'spinner', attrs: { role: 'status', 'aria-label': label } }),
  );
}
