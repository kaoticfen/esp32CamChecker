import { api } from '../api.ts';
import { el } from '../dom.ts';
import { clearError, errorBox, showError } from '../shell.ts';

export function renderLogin(root: HTMLElement): void {
  const error = errorBox();
  const username = el('input', {
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    value: 'admin',
  });
  const password = el('input', {
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
  });
  const submit = el('button', { type: 'submit', class: 'primary', text: 'Sign in' });

  const form = el(
    'form',
    {
      onsubmit: (event) => {
        event.preventDefault();
        clearError(error);
        submit.disabled = true;
        submit.textContent = 'Signing in…';

        void api
          .login(username.value, password.value)
          .then(() => {
            window.dispatchEvent(new CustomEvent('hub:authenticated'));
          })
          .catch((err: unknown) => showError(error, err))
          .finally(() => {
            submit.disabled = false;
            submit.textContent = 'Sign in';
          });
      },
    },
    el('div', { class: 'field' }, el('label', { text: 'Username' }), username),
    el('div', { class: 'field' }, el('label', { text: 'Password' }), password),
    submit,
  );

  root.replaceChildren(
    el(
      'div',
      { class: 'login' },
      el('h1', { text: 'Cam Checker' }),
      error,
      el('div', { class: 'card pad' }, form),
    ),
  );
  password.focus();
}
