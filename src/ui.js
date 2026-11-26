// Pequenos utilitários de interface compartilhados pelos painéis.

import { escapeHtml } from './util.js';

function context() {
    return SillyTavern.getContext();
}

export async function promptText(title, defaultValue = '', hint = '') {
    const { Popup } = context();
    if (Popup?.show?.input) {
        const value = await Popup.show.input(title, hint, defaultValue);
        return typeof value === 'string' ? value : null;
    }
    return window.prompt(hint ? `${title}\n${hint}` : title, defaultValue);
}

export async function confirmDialog(title, text) {
    const { Popup, POPUP_RESULT } = context();
    if (Popup?.show?.confirm) {
        const result = await Popup.show.confirm(title, text);
        return POPUP_RESULT ? result === POPUP_RESULT.AFFIRMATIVE : Boolean(result);
    }
    return window.confirm(text ? `${title}\n\n${text}` : title);
}

export function renderMarkdown(text) {
    const libs = globalThis.SillyTavern?.libs ?? {};
    if (libs.showdown?.Converter && libs.DOMPurify?.sanitize) {
        const converter = new libs.showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true });
        return libs.DOMPurify.sanitize(converter.makeHtml(text));
    }
    return `<pre>${escapeHtml(text)}</pre>`;
}

export function downloadText(fileName, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
