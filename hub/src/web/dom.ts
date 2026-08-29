export type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  class?: string;
  text?: string;
  href?: string;
  src?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  hidden?: boolean;
  autocomplete?: string;
  name?: string;
  download?: string;
  onclick?: (event: MouseEvent) => void;
  onsubmit?: (event: SubmitEvent) => void;
  onchange?: (event: Event) => void;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
}

/**
 * Small DOM builder. Everything user- or device-supplied (camera names, SD
 * filenames, error text) reaches the page as a text node, so no interpolation
 * can turn into markup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, text, dataset, attrs, ...rest } = options;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);

  Object.assign(node, rest);

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** SD cards report seconds; JS wants milliseconds. Zero means "no timestamp". */
export function formatFileTime(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleString();
}
