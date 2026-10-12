// Search modelled after the Bitwarden clients (libs/common search.service):
// every whitespace-separated token is matched as a substring ("*token*")
// against an entry's weighted fields. Entries matching more tokens rank
// first, then by score, then in their original order.

export function normalize(text) {
    return (text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
}

/**
 * @param {object[]} entries
 * @param {function(object): Array<[number, string|string[]]>} fieldsOf -
 *   returns [weight, value(s)] pairs to search for an entry
 */
export function prepare(entries, fieldsOf) {
    return entries.map((entry, index) => ({
        ...entry,
        _index: index,
        _fields: fieldsOf(entry).map(([weight, values]) =>
            [weight, [values].flat().filter(Boolean).map(normalize)]),
    }));
}

function fieldScore(value, token) {
    const index = value.indexOf(token);
    if (index < 0)
        return 0;

    let score = 1;
    if (value === token)
        score += 2;
    else if (index === 0)
        score += 1;
    else if (/[^\p{L}\p{N}]/u.test(value[index - 1]))
        score += 0.5;

    // Shorter fields with a match are more relevant (like BM25 length norm).
    return score * (1 + token.length / value.length);
}

function scoreEntry(entry, tokens) {
    let matched = 0;
    let score = 0;

    for (const token of tokens) {
        let tokenScore = 0;
        for (const [weight, values] of entry._fields)
            tokenScore += weight * Math.max(0, ...values.map(v => fieldScore(v, token)));

        if (tokenScore > 0) {
            matched++;
            score += tokenScore;
        }
    }

    return {matched, score};
}

/**
 * @param {object[]} entries - entries returned by prepare()
 * @param {string} query
 * @returns {object[]} matching entries, best first
 */
export function search(entries, query) {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return entries.slice();

    return entries
        .map(entry => ({entry, ...scoreEntry(entry, tokens)}))
        .filter(r => r.matched > 0)
        .sort((a, b) =>
            b.matched - a.matched ||
            b.score - a.score ||
            a.entry._index - b.entry._index)
        .map(r => r.entry);
}
