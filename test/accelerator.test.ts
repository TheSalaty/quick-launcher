import assert from 'node:assert/strict';
import {test} from 'node:test';

import {shortcutText} from '../src/lib/accelerator.ts';

test('shortcutText', () => {
    assert.equal(shortcutText('<Shift><Control>Return'), 'Ctrl+Shift+Enter');
    assert.equal(shortcutText('<Super>space'), 'Super+space');
    assert.equal(shortcutText('<Alt>k'), 'Alt+K');
    assert.equal(shortcutText(undefined), 'your shortcut');
});
