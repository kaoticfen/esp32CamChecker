import { api } from './api.ts';
import { renderAdd } from './views/add.ts';
import { renderCamera } from './views/camera.ts';
import { renderGrid } from './views/grid.ts';
import { renderLogin } from './views/login.ts';
import { renderSd } from './views/sd.ts';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app container');

type Route =
  | { name: 'grid' }
  | { name: 'add' }
  | { name: 'camera'; id: string }
  | { name: 'sd'; id: string; path: string };

/**
 * Hash routing, so every URL is served by the same static index.html and the
 * hub needs no history-API catch-all.
 */
function parseRoute(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const query = new URLSearchParams(queryPart);
  const segments = pathPart.split('/').filter(Boolean);

  if (segments[0] === 'add') return { name: 'add' };
  if (segments[0] === 'cam' && segments[1]) {
    const id = decodeURIComponent(segments[1]);
    if (segments[2] === 'sd') return { name: 'sd', id, path: query.get('path') ?? '/' };
    return { name: 'camera', id };
  }
  return { name: 'grid' };
}

let teardown: (() => void) | null = null;
let authenticated = false;
let showingLogin = false;

function render(): void {
  teardown?.();
  teardown = null;

  if (!authenticated) {
    showingLogin = true;
    renderLogin(root!);
    return;
  }
  showingLogin = false;

  const route = parseRoute();
  switch (route.name) {
    case 'add':
      teardown = renderAdd(root!);
      break;
    case 'camera':
      teardown = renderCamera(root!, route.id);
      break;
    case 'sd':
      teardown = renderSd(root!, route.id, route.path);
      break;
    default:
      teardown = renderGrid(root!);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);

window.addEventListener('hub:unauthorized', () => {
  // Polling views can raise this repeatedly; re-rendering would wipe whatever
  // the user has already typed into the login form.
  if (!authenticated && showingLogin) return;
  authenticated = false;
  render();
});

window.addEventListener('hub:authenticated', () => {
  authenticated = true;
  render();
});

async function boot(): Promise<void> {
  try {
    const me = await api.me();
    authenticated = me.username !== null;
  } catch {
    authenticated = false;
  }
  render();
}

void boot();
