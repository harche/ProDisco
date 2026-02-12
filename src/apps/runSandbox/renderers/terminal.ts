export function renderTerminal(container: HTMLElement, text: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal';

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  wrapper.appendChild(pre);

  container.appendChild(wrapper);
}
