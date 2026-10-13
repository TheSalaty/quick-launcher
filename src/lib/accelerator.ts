/** "<Shift><Control>Return" → "Ctrl+Shift+Enter" */
export function shortcutText(accelerator: string | undefined): string {
    if (!accelerator)
        return 'your shortcut';
    const names: Record<string, string> = {control: 'Ctrl', primary: 'Ctrl', shift: 'Shift', alt: 'Alt', super: 'Super', meta: 'Super'};
    const modifiers = [...accelerator.matchAll(/<(\w+)>/g)].map(m => names[m[1].toLowerCase()] ?? m[1]);
    const order = ['Super', 'Ctrl', 'Alt', 'Shift'];
    modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = accelerator.replace(/<\w+>/g, '');
    const keyName = key === 'Return' ? 'Enter' : key.length === 1 ? key.toUpperCase() : key;
    return [...modifiers, keyName].join('+');
}
